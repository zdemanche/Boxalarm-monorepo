import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: "us-east-1", region: "us-east-1", id: "us-east-1" };
      }
      return args.inputs;
    },
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

const TABLE_ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-alerting-table";
const STREAM_ARN = `${TABLE_ARN}/stream/2026-01-01T00:00:00.000`;
const CMK_ARN = "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk";
const BUS_ARN = "arn:aws:events:us-east-1:123456789012:event-bus/boxalarm-dev-platform-bus";
const BOUNDARY_ARN = "arn:aws:iam::123456789012:policy/boxalarm-dev-alerting-plane-boundary";
const PAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";

type Statement = {
  Sid: string;
  Action: string[];
  Resource: string;
  Condition?: Record<string, Record<string, string[]>>;
};

describe("AlertingOutboxDrain", () => {
  async function build() {
    const { AlertingOutboxDrain } = await import("../../components/alerting/outbox-drain");
    const logGroup = new ServiceLogGroup("test-alerting-log-group", {
      env: "dev",
      serviceName: "alerting-service",
    });
    return new AlertingOutboxDrain("test-drain", {
      env: "dev",
      alertingTableName: pulumi.output("boxalarm-dev-alerting-table"),
      alertingTableArn: pulumi.output(TABLE_ARN),
      alertingStreamArn: pulumi.output(STREAM_ARN),
      alertingCmkArn: pulumi.output(CMK_ARN),
      busName: pulumi.output("boxalarm-dev-platform-bus"),
      busArn: pulumi.output(BUS_ARN),
      logGroup,
      permissionsBoundaryArn: pulumi.output(BOUNDARY_ARN),
      pageTopicArn: pulumi.output(PAGE_TOPIC_ARN),
    });
  }

  it("routes every bridge alarm to the alerting page topic", async () => {
    const drain = await build();
    for (const alarm of [
      drain.onFailureAlarm,
      drain.publishFailedAlarm,
      drain.eventTypeRejectedAlarm,
    ]) {
      expect(await resolve(alarm.alarmActions)).toEqual([PAGE_TOPIC_ARN]);
    }
  });

  async function statements(drain: Awaited<ReturnType<typeof build>>): Promise<Statement[]> {
    const policyJson = await resolve(drain.lambda.rolePolicy.policy);
    return (JSON.parse(policyJson) as { Statement: Statement[] }).Statement;
  }

  it("deploys the backend alerting-service/outbox-drain bundle with the env the shared drain reads", async () => {
    const drain = await build();
    const [name, env] = await Promise.all([
      resolve(drain.lambda.function.name),
      resolve(drain.lambda.function.environment),
    ]);
    expect(name).toBe("boxalarm-dev-alerting-outbox-drain");
    // outboxDrainHandler.ts: tableNameEnvVar 'ALERTING_TABLE_NAME' + PLATFORM_EVENT_BUS_NAME.
    expect(env?.variables?.ALERTING_TABLE_NAME).toBe("boxalarm-dev-alerting-table");
    expect(env?.variables?.PLATFORM_EVENT_BUS_NAME).toBe("boxalarm-dev-platform-bus");
    expect(env?.variables?.SERVICE_NAME).toBe("alerting-service");
  });

  it("maps the alerting-table stream with ReportBatchItemFailures, so a returned batchItemFailures is retried rather than dropped", async () => {
    const drain = await build();
    const [source, responseTypes] = await Promise.all([
      resolve(drain.eventSourceMapping.eventSourceArn),
      resolve(drain.eventSourceMapping.functionResponseTypes),
    ]);
    expect(source).toBe(STREAM_ARN);
    expect(responseTypes).toEqual(["ReportBatchItemFailures"]);
  });

  it("filters the mapping to INSERT of OUTBOX_ENTRY only", async () => {
    const drain = await build();
    const filters = await resolve(drain.eventSourceMapping.filterCriteria);
    expect(filters?.filters).toHaveLength(1);
    expect(JSON.parse(filters?.filters?.[0]?.pattern ?? "{}")).toEqual({
      eventName: ["INSERT"],
      dynamodb: { NewImage: { entityType: { S: ["OUTBOX_ENTRY"] } } },
    });
  });

  it("bisects, bounds retries and record age, and routes exhausted records to an alarmed on-failure queue", async () => {
    const drain = await build();
    const [bisect, retries, maxAge, destination, queueArn, alarmDimensions] = await Promise.all([
      resolve(drain.eventSourceMapping.bisectBatchOnFunctionError),
      resolve(drain.eventSourceMapping.maximumRetryAttempts),
      resolve(drain.eventSourceMapping.maximumRecordAgeInSeconds),
      resolve(drain.eventSourceMapping.destinationConfig),
      resolve(drain.onFailureQueue.arn),
      resolve(drain.onFailureAlarm.dimensions),
    ]);
    expect(bisect).toBe(true);
    expect(retries).toBeGreaterThan(0);
    expect(retries).toBeLessThanOrEqual(10);
    expect(maxAge).toBeGreaterThan(0);
    expect(destination?.onFailure?.destinationArn).toBe(queueArn);
    expect(alarmDimensions?.QueueName).toBe("boxalarm-dev-alerting-outbox-drain-onfailure");
  });

  it("grants PutEvents on the platform bus, UpdateItem on the alerting table, stream read, and SendMessage to the on-failure queue", async () => {
    const drain = await build();
    const all = await statements(drain);
    const bySid = (sid: string) => all.find((s) => s.Sid === sid);
    expect(bySid("PublishToPlatformBus")).toMatchObject({
      Action: ["events:PutEvents"],
      Resource: BUS_ARN,
    });
    expect(bySid("MarkAlertingOutboxEntrySent")).toMatchObject({
      Action: ["dynamodb:UpdateItem"],
      Resource: TABLE_ARN,
    });
    expect(bySid("ReadAlertingTableStream")).toMatchObject({
      Action: expect.arrayContaining([
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:DescribeStream",
        "dynamodb:ListStreams",
      ]) as unknown,
      Resource: STREAM_ARN,
    });
    expect(bySid("SendToOnFailureDestination")).toMatchObject({
      Action: ["sqs:SendMessage"],
      Resource: "arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-outbox-drain-onfailure",
    });
  });

  it("grants kms:Decrypt on the alerting CMK only via DynamoDB", async () => {
    const drain = await build();
    const kms = (await statements(drain)).find((s) => s.Sid === "DecryptAlertingTableViaDynamoDb");
    expect(kms?.Action).toEqual(["kms:Decrypt"]);
    expect(kms?.Resource).toBe(CMK_ARN);
    expect(kms?.Condition).toEqual({
      StringEquals: { "kms:ViaService": ["dynamodb.us-east-1.amazonaws.com"] },
    });
  });

  it("grants no DynamoDB access beyond the alerting table and its stream (alerting isolation)", async () => {
    const drain = await build();
    const dynamo = (await statements(drain)).filter((s) =>
      s.Action.some((a) => a.startsWith("dynamodb:")),
    );
    for (const statement of dynamo) {
      expect(statement.Resource.startsWith(TABLE_ARN)).toBe(true);
    }
  });

  it("attaches the alerting permissions boundary and its own reserved concurrency", async () => {
    const drain = await build();
    const [boundary, reserved] = await Promise.all([
      resolve(drain.lambda.role.permissionsBoundary),
      resolve(drain.lambda.function.reservedConcurrentExecutions),
    ]);
    expect(boundary).toBe(BOUNDARY_ARN);
    expect(reserved).toBeGreaterThan(0);
  });

  it("alarms on the backend drain's PublishFailed and EventTypeRejected metrics in its namespace", async () => {
    const drain = await build();
    const [pfNamespace, pfMetric, rejNamespace, rejMetric] = await Promise.all([
      resolve(drain.publishFailedAlarm.namespace),
      resolve(drain.publishFailedAlarm.metricName),
      resolve(drain.eventTypeRejectedAlarm.namespace),
      resolve(drain.eventTypeRejectedAlarm.metricName),
    ]);
    expect(pfNamespace).toBe("Boxalarm/alerting-bridge");
    expect(pfMetric).toBe("PublishFailed");
    expect(rejNamespace).toBe("Boxalarm/alerting-bridge");
    expect(rejMetric).toBe("EventTypeRejected");
  });
});
