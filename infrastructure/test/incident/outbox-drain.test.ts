import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";

const TABLE_ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-incident-service";
const STREAM_ARN = `${TABLE_ARN}/stream/2026-01-01T00:00:00.000`;
const CMK_ARN = "arn:aws:kms:us-east-1:123456789012:key/incident-cmk";
const BUS_ARN = "arn:aws:events:us-east-1:123456789012:event-bus/boxalarm-dev-platform-bus";

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
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

interface PolicyDoc {
  Statement: Array<{ Sid: string; Action: string[]; Resource: string }>;
}

describe("IncidentOutboxDrain", () => {
  async function build() {
    const { IncidentOutboxDrain } = await import("../../components/incident/outbox-drain");
    const logGroup = new ServiceLogGroup("test-incident-log-group", {
      env: "dev",
      serviceName: "incident-service",
    });
    return new IncidentOutboxDrain("test-incident-outbox-drain", {
      env: "dev",
      incidentTableName: pulumi.output("boxalarm-dev-incident-service"),
      incidentTableArn: pulumi.output(TABLE_ARN),
      incidentTableStreamArn: pulumi.output(STREAM_ARN),
      incidentCmkArn: pulumi.output(CMK_ARN),
      busName: pulumi.output("boxalarm-dev-platform-bus"),
      busArn: pulumi.output(BUS_ARN),
      logGroup,
    });
  }

  it("maps the INCIDENT table stream (not the platform table) to the incident outbox-drain Lambda", async () => {
    const drain = await build();
    const [source, fnName] = await Promise.all([
      resolve(drain.eventSourceMapping.eventSourceArn),
      resolve(drain.lambda.function.name),
    ]);
    expect(source).toBe(STREAM_ARN);
    expect(fnName).toBe("boxalarm-dev-incident-outbox-drain");
  });

  it("filters at the ESM to INSERTs of entityType = OUTBOX_ENTRY", async () => {
    const drain = await build();
    const filters = await resolve(drain.eventSourceMapping.filterCriteria);
    const pattern = JSON.parse(filters?.filters?.[0]?.pattern ?? "{}") as {
      eventName: string[];
      dynamodb: { NewImage: { entityType: { S: string[] } } };
    };
    expect(pattern.eventName).toEqual(["INSERT"]);
    expect(pattern.dynamodb.NewImage.entityType.S).toEqual(["OUTBOX_ENTRY"]);
  });

  it("reports batch item failures, bisects, bounds retries, and routes exhausted records to an on-failure queue", async () => {
    const drain = await build();
    const esm = drain.eventSourceMapping;
    const [responseTypes, bisect, retries, maxAge, destination, queueArn] = await Promise.all([
      resolve(esm.functionResponseTypes),
      resolve(esm.bisectBatchOnFunctionError),
      resolve(esm.maximumRetryAttempts),
      resolve(esm.maximumRecordAgeInSeconds),
      resolve(esm.destinationConfig),
      resolve(drain.onFailureQueue.arn),
    ]);
    expect(responseTypes).toEqual(["ReportBatchItemFailures"]);
    expect(bisect).toBe(true);
    expect(retries).toBeGreaterThan(0);
    expect(maxAge).toBeGreaterThan(0);
    expect(destination?.onFailure?.destinationArn).toBe(queueArn);
  });

  it("grants PutEvents on the bus, UpdateItem (markSent) on the incident table, and the incident CMK", async () => {
    const drain = await build();
    const policy = JSON.parse(await resolve(drain.lambda.rolePolicy.policy)) as PolicyDoc;
    const bySid = (sid: string) => policy.Statement.find((s) => s.Sid === sid);
    expect(bySid("PublishToPlatformBus")?.Action).toEqual(["events:PutEvents"]);
    expect(bySid("PublishToPlatformBus")?.Resource).toBe(BUS_ARN);
    expect(bySid("MarkOutboxEntrySent")?.Action).toEqual(["dynamodb:UpdateItem"]);
    expect(bySid("MarkOutboxEntrySent")?.Resource).toBe(TABLE_ARN);
    expect(bySid("IncidentCmkAccess")?.Action).toContain("kms:Decrypt");
    expect(bySid("IncidentCmkAccess")?.Resource).toBe(CMK_ARN);
  });

  it("grants sqs:SendMessage on its own on-failure queue so exhausted records reach it", async () => {
    const drain = await build();
    const [policyJson, queueArn] = await Promise.all([
      resolve(drain.onFailureSendPolicy.policy),
      resolve(drain.onFailureQueue.arn),
    ]);
    const statement = (JSON.parse(policyJson) as PolicyDoc).Statement.find(
      (s) => s.Sid === "SendToOnFailureQueue",
    );
    expect(statement?.Action).toEqual(["sqs:SendMessage"]);
    expect(statement?.Resource).toBe(queueArn);
  });

  it("grants stream read on the incident table stream only", async () => {
    const drain = await build();
    const policy = JSON.parse(await resolve(drain.streamReadPolicy.policy)) as PolicyDoc;
    const statement = policy.Statement.find((s) => s.Sid === "ReadIncidentTableStream");
    expect(statement?.Action).toEqual(
      expect.arrayContaining(["dynamodb:GetRecords", "dynamodb:GetShardIterator"]),
    );
    expect(statement?.Resource).toBe(STREAM_ARN);
  });

  it("points the shared drain handler's table + bus env at the incident table and platform bus", async () => {
    const drain = await build();
    const env = await resolve(drain.lambda.function.environment);
    expect(env?.variables?.PLATFORM_TABLE_NAME).toBe("boxalarm-dev-incident-service");
    expect(env?.variables?.PLATFORM_EVENT_BUS_NAME).toBe("boxalarm-dev-platform-bus");
  });
});
