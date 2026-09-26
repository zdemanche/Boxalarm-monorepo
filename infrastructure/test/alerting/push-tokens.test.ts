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
        state.url = `https://sqs.us-east-1.amazonaws.com/123456789012/${args.inputs.name ?? args.name}`;
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

describe("PushTokens — member-updated consumer IAM isolation (#208 AC3)", () => {
  async function build() {
    const { PushTokens } = await import("../../components/alerting/push-tokens");
    const personnelLogGroup = new ServiceLogGroup("test-push-tokens-personnel-log-group", {
      env: "dev",
      serviceName: "personnel-service",
    });
    const alertingLogGroup = new ServiceLogGroup("test-push-tokens-alerting-log-group", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const httpApi = new HttpApi("test-push-tokens-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: personnelLogGroup,
    });
    return new PushTokens("test-push-tokens", {
      env: "dev",
      httpApi,
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      platformTableName: pulumi.output("platform-table"),
      alertingTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/alerting"),
      alertingCmkArn: "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk",
      alertingTableName: pulumi.output("alerting-table"),
      personnelLogGroup,
      alertingLogGroup,
      policyStoreId: pulumi.output("ps-1"),
      busName: pulumi.output("boxalarm-dev-platform-bus"),
      alertingPermissionsBoundaryArn: pulumi.output(
        "arn:aws:iam::123456789012:policy/boxalarm-dev-alerting-plane-boundary",
      ),
    });
  }

  it("grants the member-updated consumer role only the alerting table, never platform-service (AC3)", async () => {
    const pushTokens = await build();
    const policyJson = await resolve(pushTokens.memberUpdatedConsumer.rolePolicy.policy);
    expect(policyJson).toContain("table/alerting");
    expect(policyJson).not.toContain("table/platform");
    expect(policyJson).not.toContain("table/incident");
  });

  it("grants register/revoke every item action of their TransactWriteCommand (Update + Put)", async () => {
    const pushTokens = await build();
    for (const route of [pushTokens.registerRoute, pushTokens.revokeRoute]) {
      const policyJson = await resolve(route.lambda.rolePolicy.policy);
      const statements = (
        JSON.parse(policyJson) as {
          Statement: { Sid?: string; Action: string[]; Resource: string }[];
        }
      ).Statement;
      const platform = statements.find((s) => s.Sid === "PlatformTableReadWrite");
      expect(platform?.Resource).toBe("arn:aws:dynamodb:us-east-1:123456789012:table/platform");
      expect([...(platform?.Action ?? [])].sort()).toEqual(
        [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem",
        ].sort(),
      );
    }
  });

  it("routes personnel.member.updated only from personnel-service onto the consumer queue", async () => {
    const pushTokens = await build();
    const patternJson = await resolve(pushTokens.memberUpdatedRule.eventPattern);
    const pattern = JSON.parse(patternJson ?? "null") as Record<string, unknown>;
    expect(pattern).toEqual({
      source: ["personnel-service"],
      "detail-type": ["personnel.member.updated"],
    });
  });

  it("caps the member-updated ESM at the consumer's reserved concurrency", async () => {
    const pushTokens = await build();
    const [reserved, esmScaling] = await Promise.all([
      resolve(pushTokens.memberUpdatedConsumer.function.reservedConcurrentExecutions),
      resolve(pushTokens.memberUpdatedEventSource.scalingConfig),
    ]);
    expect(reserved).toBe(5);
    expect(esmScaling).toEqual({ maximumConcurrency: 5 });
  });

  it("does not VPC-attach the member-updated consumer", async () => {
    const pushTokens = await build();
    const vpcConfig = await resolve(pushTokens.memberUpdatedConsumer.function.vpcConfig);
    expect(vpcConfig).toBeUndefined();
  });

  it("wires the member-updated queue with a DLQ", async () => {
    const pushTokens = await build();
    const [queueName, redrive] = await Promise.all([
      resolve(pushTokens.memberUpdatedQueue.name),
      resolve(pushTokens.memberUpdatedQueue.redrivePolicy),
    ]);
    expect(queueName).toBe("boxalarm-dev-alerting-member-updated-queue");
    const parsed = JSON.parse(redrive as string) as { maxReceiveCount: number };
    expect(parsed.maxReceiveCount).toBe(5);
  });
});
