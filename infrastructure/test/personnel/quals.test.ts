import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { PlatformBus } from "../../components/messaging/platform-bus";

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
      if (args.type === "aws:cloudwatch/eventBus:EventBus") {
        state.arn = `arn:aws:events:us-east-1:123456789012:event-bus/${args.inputs.name}`;
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

describe("Quals — eligibility-changed consumer (#114/#204)", () => {
  async function build() {
    const { Quals } = await import("../../components/personnel/quals");
    const logGroup = new ServiceLogGroup("test-quals-log-group", {
      env: "dev",
      serviceName: "personnel-service",
    });
    const alertingLogGroup = new ServiceLogGroup("test-quals-alerting-log-group", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const httpApi = new HttpApi("test-quals-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    const platformBus = new PlatformBus("test-quals-platform-bus", { env: "dev" });
    return new Quals("test-quals", {
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      logGroup,
      httpApi,
      platformBus,
      alertingTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/alerting"),
      alertingCmkArn: "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk",
      alertingTableName: pulumi.output("alerting-table"),
      alertingLogGroup,
      alertingPermissionsBoundaryArn: pulumi.output(
        "arn:aws:iam::123456789012:policy/boxalarm-dev-alerting-plane-boundary",
      ),
    });
  }

  it("wires the eligibility-changed-snapshot-queue with a DLQ (AC4)", async () => {
    const quals = await build();
    const [dlqName, redrive] = await Promise.all([
      resolve(quals.eligibilityChangedQueueConsumer.dlq.name),
      resolve(quals.eligibilityChangedQueueConsumer.queue.redrivePolicy),
    ]);
    expect(dlqName).toBe("boxalarm-dev-eligibility-changed-snapshot-queue-dlq");
    const parsed = JSON.parse(redrive as string) as { maxReceiveCount: number };
    expect(parsed.maxReceiveCount).toBe(5);
  });

  it("alarms on DLQ depth above zero (AC4)", async () => {
    const quals = await build();
    const [threshold, comparison] = await Promise.all([
      resolve(quals.eligibilityChangedQueueConsumer.dlqDepthAlarm.threshold),
      resolve(quals.eligibilityChangedQueueConsumer.dlqDepthAlarm.comparisonOperator),
    ]);
    expect(threshold).toBe(0);
    expect(comparison).toBe("GreaterThanThreshold");
  });

  it("routes only personnel.eligibility.changed onto the queue (#114)", async () => {
    const quals = await build();
    const pattern = await resolve(quals.eligibilityChangedQueueConsumer.rule.eventPattern);
    expect(JSON.parse(pattern as string)).toEqual({
      "detail-type": ["personnel.eligibility.changed"],
    });
  });

  it("grants the eligibility-changed consumer role only the alerting table, never platform-service (AC3)", async () => {
    const quals = await build();
    const policyJson = await resolve(quals.eligibilityChangedConsumer.rolePolicy.policy);
    expect(policyJson).toContain("table/alerting");
    expect(policyJson).not.toContain("table/platform");
    expect(policyJson).not.toContain("table/incident");
  });

  it("does not VPC-attach the eligibility-changed consumer", async () => {
    const quals = await build();
    const vpcConfig = await resolve(quals.eligibilityChangedConsumer.function.vpcConfig);
    expect(vpcConfig).toBeUndefined();
  });
});
