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

describe("Availability — availability-changed consumer (#207)", () => {
  async function build() {
    const { Availability } = await import("../../components/personnel/availability");
    const logGroup = new ServiceLogGroup("test-availability-log-group", {
      env: "dev",
      serviceName: "personnel-service",
    });
    const alertingLogGroup = new ServiceLogGroup("test-availability-alerting-log-group", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const httpApi = new HttpApi("test-availability-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    const platformBus = new PlatformBus("test-availability-platform-bus", { env: "dev" });
    return new Availability("test-availability", {
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

  it("wires the availability-snapshot-queue with a DLQ (scope line)", async () => {
    const availability = await build();
    const [dlqName, redrive] = await Promise.all([
      resolve(availability.availabilityChangedQueueConsumer.dlq.name),
      resolve(availability.availabilityChangedQueueConsumer.queue.redrivePolicy),
    ]);
    expect(dlqName).toBe("boxalarm-dev-availability-snapshot-queue-dlq");
    const parsed = JSON.parse(redrive as string) as { maxReceiveCount: number };
    expect(parsed.maxReceiveCount).toBe(5);
  });

  it("alarms on DLQ depth above zero", async () => {
    const availability = await build();
    const [threshold, comparison] = await Promise.all([
      resolve(availability.availabilityChangedQueueConsumer.dlqDepthAlarm.threshold),
      resolve(availability.availabilityChangedQueueConsumer.dlqDepthAlarm.comparisonOperator),
    ]);
    expect(threshold).toBe(0);
    expect(comparison).toBe("GreaterThanThreshold");
  });

  it("routes only personnel.availability.changed onto the queue", async () => {
    const availability = await build();
    const pattern = await resolve(availability.availabilityChangedQueueConsumer.rule.eventPattern);
    expect(JSON.parse(pattern as string)).toEqual({
      "detail-type": ["personnel.availability.changed"],
    });
  });

  it("grants the availability-changed consumer role only the alerting table, denied on platform/incident (AC5)", async () => {
    const availability = await build();
    const policyJson = await resolve(availability.availabilityChangedConsumer.rolePolicy.policy);
    expect(policyJson).toContain("table/alerting");
    expect(policyJson).not.toContain("table/platform");
    expect(policyJson).not.toContain("table/incident");
  });

  it("grants the availability-changed consumer every item action of its transaction (Put + Update)", async () => {
    const availability = await build();
    const policyJson = await resolve(availability.availabilityChangedConsumer.rolePolicy.policy);
    const statements = (
      JSON.parse(policyJson) as { Statement: { Sid?: string; Action: string[] }[] }
    ).Statement;
    const write = statements.find((s) => s.Sid === "AlertingTableWrite");
    expect(write?.Action).toEqual(
      expect.arrayContaining(["dynamodb:PutItem", "dynamodb:UpdateItem"]),
    );
  });

  it("does not VPC-attach the availability-changed consumer", async () => {
    const availability = await build();
    const vpcConfig = await resolve(availability.availabilityChangedConsumer.function.vpcConfig);
    expect(vpcConfig).toBeUndefined();
  });
});
