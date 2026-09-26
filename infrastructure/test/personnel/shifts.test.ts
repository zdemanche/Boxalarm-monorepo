import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:apigatewayv2/api:Api") {
        state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
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

describe("Shifts — shift-completion schedule (#213)", () => {
  async function build() {
    const { Shifts } = await import("../../components/personnel/shifts");
    const logGroup = new ServiceLogGroup("test-shifts-log-group", {
      env: "dev",
      serviceName: "personnel-service",
    });
    const httpApi = new HttpApi("test-shifts-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Shifts("test-shifts", {
      env: "dev",
      deptId: "nichols-fd",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      logGroup,
      httpApi,
    });
  }

  it("fires the completion sweep hourly with the configured deptId (AC1)", async () => {
    const shifts = await build();
    const [schedule, target] = await Promise.all([
      resolve(shifts.completionSchedule.scheduleExpression),
      resolve(shifts.completionSchedule.target),
    ]);
    expect(schedule).toBe("rate(1 hour)");
    expect(JSON.parse(target.input as string)).toEqual({ deptId: "nichols-fd" });
  });

  it("retries then routes a failed invocation to the DLQ (AC3)", async () => {
    const shifts = await build();
    const target = await resolve(shifts.completionSchedule.target);
    expect(target.retryPolicy?.maximumRetryAttempts).toBeGreaterThan(0);
    expect(target.deadLetterConfig?.arn).toBeDefined();
  });

  it("alarms on the completion DLQ depth and on Lambda Errors (AC3)", async () => {
    const shifts = await build();
    const [dlqThreshold, dlqComparison, errorsNamespace, errorsMetric] = await Promise.all([
      resolve(shifts.completionDlqAlarm.threshold),
      resolve(shifts.completionDlqAlarm.comparisonOperator),
      resolve(shifts.completionErrorsAlarm.namespace),
      resolve(shifts.completionErrorsAlarm.metricName),
    ]);
    expect(dlqThreshold).toBe(0);
    expect(dlqComparison).toBe("GreaterThanThreshold");
    expect(errorsNamespace).toBe("AWS/Lambda");
    expect(errorsMetric).toBe("Errors");
  });

  it("scopes the scheduler role to invoking only the completion Lambda", async () => {
    const shifts = await build();
    const target = await resolve(shifts.completionSchedule.target);
    const completionArn = await resolve(shifts.completionLambda.function.arn);
    expect(target.arn).toBe(completionArn);
    expect(target.roleArn).toBeDefined();
  });

  it("grants the completion role Query on GSI3 and item-level Put/Update, never on the alerting table", async () => {
    const shifts = await build();
    const policyJson = await resolve(shifts.completionLambda.rolePolicy.policy);
    expect(policyJson).toContain("/index/GSI3");
    // TransactWriteItems is not an IAM action; transaction items are authorized as
    // PutItem/UpdateItem.
    expect(policyJson).not.toContain("dynamodb:TransactWriteItems");
    expect(policyJson).toContain("dynamodb:PutItem");
    expect(policyJson).toContain("dynamodb:UpdateItem");
    expect(policyJson).not.toContain("table/alerting");
  });
});
