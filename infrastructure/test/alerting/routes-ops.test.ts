import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";

let routeAuthTypes: Record<string, string>;

beforeEach(() => {
  vi.resetModules();
  routeAuthTypes = {};
  pulumi.runtime.setMocks(
    {
      newResource: (args: pulumi.runtime.MockResourceArgs) => {
        const state: Record<string, unknown> = { ...args.inputs };
        if (args.type === "aws:iam/role:Role") {
          state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
        }
        if (args.type === "aws:lambda/function:Function") {
          const fnName = (args.inputs.name as string) ?? args.name;
          state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${fnName}`;
          state.invokeArn = `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${state.arn}/invocations`;
        }
        if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
          state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
        }
        if (args.type === "aws:apigatewayv2/api:Api") {
          state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
          state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
        }
        if (args.type === "aws:apigatewayv2/route:Route") {
          routeAuthTypes[args.inputs.routeKey as string] = args.inputs.authorizationType as string;
        }
        if (args.type === "aws:verifiedpermissions/policyStore:PolicyStore") {
          state.arn = `arn:aws:verifiedpermissions::123456789012:policy-store/${args.name}`;
        }
        return { id: `${args.name}-id`, state };
      },
      call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
    },
    "boxalarm-infra",
    "dev",
  );
  pulumi.runtime.setAllConfig({
    "boxalarm-infra:env": "dev",
    "boxalarm-infra:webOrigin": "https://localhost:5173",
    "boxalarm-infra:smsWebhookSecret": "test-sms-secret",
    "boxalarm-infra:voiceWebhookSecret": "test-voice-secret",
    "boxalarm-infra:pushWebhookSecret": "test-push-secret",
  });
});

describe("RoutesOps webhook routes", () => {
  it("never attaches the Cognito/Verified-Permissions authorizer to a vendor webhook route", async () => {
    const { HttpApi } = await import("../../components/api/http-api");
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { RoutesOps } = await import("../../components/alerting/routes-ops");

    const httpApi = new HttpApi("http-api", {
      env: "dev",
      userPoolId: "pool-1",
      allowedClientIds: ["client-1"],
      platformLogGroup: new ServiceLogGroup("platform-lg", {
        env: "dev",
        serviceName: "platform-service",
      }),
    });
    const alertingLogGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });

    new RoutesOps("routes-ops", {
      env: "dev",
      httpApi,
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/alerting",
      alertingCmkArn: "arn:aws:kms:us-east-1:123456789012:key/alerting-cmk",
      alertingTableName: "boxalarm-dev-alerting-table",
      logGroup: alertingLogGroup,
      policyStoreId: "policy-store-id",
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Assert each webhook route exists first — a missing route would otherwise pass
    // `not.toBe("CUSTOM")` vacuously (undefined !== "CUSTOM").
    for (const routeKey of [
      "POST /api/v1/alerting/receipts/sms",
      "POST /api/v1/alerting/receipts/voice",
      "POST /api/v1/alerting/receipts/push",
    ]) {
      expect(Object.keys(routeAuthTypes), routeKey).toContain(routeKey);
      expect([undefined, "NONE"], routeKey).toContain(routeAuthTypes[routeKey]);
    }
    expect(routeAuthTypes["GET /api/v1/alerting/dispatches/{dispatchId}/receipts"]).toBe("CUSTOM");
  });
});
