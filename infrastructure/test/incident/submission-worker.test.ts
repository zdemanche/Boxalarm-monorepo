import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";

const TABLE_ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-incident-service";
const CMK_ARN = "arn:aws:kms:us-east-1:123456789012:key/incident-cmk";
const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:boxalarm-dev-neris-client-credentials";
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
      if (args.type === "aws:cloudwatch/eventRule:EventRule") {
        state.arn = `arn:aws:events:us-east-1:123456789012:rule/${args.inputs.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: "us-east-1", region: "us-east-1" };
      }
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity") {
        return { accountId: "123456789012" };
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

interface PolicyDoc {
  Statement: Array<{ Sid: string; Action: string[] | string; Resource: string | string[] }>;
}

describe("NerisSubmissionWorker", () => {
  async function build(env = "dev") {
    const { NerisSubmissionWorker } = await import("../../components/incident/submission-worker");
    const logGroup = new ServiceLogGroup(`test-incident-log-group-${env}`, {
      env,
      serviceName: "incident-service",
    });
    return new NerisSubmissionWorker(`test-submission-worker-${env}`, {
      env,
      incidentTableName: pulumi.output(`boxalarm-${env}-incident-service`),
      incidentTableArn: pulumi.output(TABLE_ARN),
      incidentCmkArn: pulumi.output(CMK_ARN),
      busName: pulumi.output(`boxalarm-${env}-platform-bus`),
      busArn: pulumi.output(BUS_ARN),
      nerisCredentialsSecretArn: pulumi.output(SECRET_ARN),
      logGroup,
    });
  }

  it("consumes neris.incident.submitted from incident-service via SQS with ReportBatchItemFailures", async () => {
    const worker = await build();
    const [pattern, responseTypes, fnName] = await Promise.all([
      resolve(worker.consumer.rule.eventPattern),
      resolve(worker.consumer.eventSourceMapping.functionResponseTypes),
      resolve(worker.consumer.eventSourceMapping.functionName),
    ]);
    expect(JSON.parse(pattern ?? "{}")).toEqual({
      source: ["incident-service"],
      "detail-type": ["neris.incident.submitted"],
    });
    expect(responseTypes).toEqual(["ReportBatchItemFailures"]);
    expect(fnName).toBe("boxalarm-dev-incident-submission-worker");
  });

  it("sets every env var the handler and neris/config.ts read", async () => {
    const worker = await build();
    const [env, schedulerRoleArn] = await Promise.all([
      resolve(worker.lambda.function.environment),
      resolve(worker.schedulerRole.arn),
    ]);
    expect(env?.variables).toMatchObject({
      INCIDENT_TABLE_NAME: "boxalarm-dev-incident-service",
      NERIS_BASE_URL_PARAM: "/boxalarm/dev/neris/base-url",
      NERIS_USER_AGENT_PARAM: "/boxalarm/dev/neris/user-agent",
      NERIS_CREDENTIALS_SECRET_ID: SECRET_ARN,
      NERIS_SUBMISSION_SCHEDULER_ROLE_ARN: schedulerRoleArn,
    });
  });

  it("tells a prod worker it is prod (BOXALARM_ENV), so it does not fail closed on the NERIS prod host", async () => {
    const worker = await build("prod");
    const env = await resolve(worker.lambda.function.environment);
    expect(env?.variables?.BOXALARM_ENV).toBe("prod");
  });

  it("scopes CreateSchedule to neris-submission-retry-* in the default group and PassRole to its own scheduler role", async () => {
    const worker = await build();
    const policy = JSON.parse(await resolve(worker.lambda.rolePolicy.policy)) as PolicyDoc;
    const schedule = policy.Statement.find((s) => s.Sid === "CreateSubmissionRetrySchedulesOnly");
    expect(schedule?.Action).toEqual(["scheduler:CreateSchedule"]);
    expect(schedule?.Resource).toBe(
      "arn:aws:scheduler:us-east-1:123456789012:schedule/default/neris-submission-retry-*",
    );
    expect(policy.Statement.find((s) => s.Sid === "NerisGetSecretValue")?.Resource).toBe(
      SECRET_ARN,
    );
    const table = policy.Statement.find((s) => s.Sid === "IncidentSubmissionAccess");
    expect(table?.Action).toEqual(
      expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]),
    );
    expect(policy.Statement.find((s) => s.Sid === "IncidentCmkAccess")?.Resource).toEqual([
      CMK_ARN,
    ]);
  });

  it("lets the scheduler role be assumed only by EventBridge Scheduler", async () => {
    const worker = await build();
    const trust = JSON.parse(await resolve(worker.schedulerRole.assumeRolePolicy)) as {
      Statement: Array<{ Principal: { Service: string } }>;
    };
    expect(trust.Statement[0]?.Principal.Service).toBe("scheduler.amazonaws.com");
  });

  it("keeps the Lambda timeout under the queue's visibility timeout", async () => {
    const worker = await build();
    const [timeout, visibility] = await Promise.all([
      resolve(worker.lambda.function.timeout),
      resolve(worker.consumer.queue.visibilityTimeoutSeconds),
    ]);
    expect(timeout).toBeGreaterThan(3);
    expect(timeout ?? 0).toBeLessThanOrEqual(visibility ?? 30);
  });
});
