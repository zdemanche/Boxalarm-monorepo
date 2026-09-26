import { beforeEach, describe, expect, it } from "vitest";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import {
  ALERT_PATH_MEMORY_MB,
  DEFAULT_WORKER_TIMEOUT_SECONDS,
  MessagingAlerting,
} from "../../components/alerting/messaging-alerting";
import { ChannelWorkers } from "../../components/alerting/channel-workers";
import { HttpApi } from "../../components/api/http-api";
import { ROUTES_OPS_TIMEOUT_SECONDS, RoutesOps } from "../../components/alerting/routes-ops";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  buildSchedulingChain,
  installMocks,
  lambdaByName,
  resourcesOfType,
  settle,
} from "./mock-harness";

beforeEach(() => {
  installMocks();
});

describe(
  "alerting-chain Lambdas set explicit timeouts (not the AWS 3s default)",
  { timeout: 30_000 },
  () => {
    it.each([
      ["boxalarm-dev-alerting-fan-out", 30],
      ["boxalarm-dev-alerting-dispatches-create", 29],
      ["boxalarm-dev-alerting-escalation", 15],
      ["boxalarm-dev-alerting-tone-evaluator", 30],
    ])("%s → %ss", async (functionName, seconds) => {
      await buildSchedulingChain();
      expect(lambdaByName(functionName).inputs.timeout).toBe(seconds);
    });

    it("keeps dispatch-ingress under the HTTP API 30s integration ceiling", async () => {
      await buildSchedulingChain();
      expect(lambdaByName("boxalarm-dev-alerting-dispatches-create").inputs.timeout).toBeLessThan(
        30,
      );
    });

    it("sizes each channel queue's visibility to 2x its worker's timeout", async () => {
      const logGroup = new ServiceLogGroup("alerting-lg", {
        env: "dev",
        serviceName: "alerting-service",
      });
      const messaging = new MessagingAlerting("messaging-alerting", { env: "dev" });
      new ChannelWorkers("channel-workers", {
        env: "dev",
        alertingTableArn: TABLE_ARN,
        alertingCmkArn: CMK_ARN,
        alertingTableName: "boxalarm-dev-alerting-table",
        channelQueues: messaging.channelQueues,
        logGroup,
        permissionsBoundaryArn: BOUNDARY_ARN,
      });
      await settle();
      for (const channel of ["push", "sms", "voice"]) {
        const worker = lambdaByName(`boxalarm-dev-alerting-${channel}-worker`);
        expect(worker.inputs.timeout).toBe(DEFAULT_WORKER_TIMEOUT_SECONDS);
        const queue = resourcesOfType("aws:sqs/queue:Queue").find(
          (q) => q.inputs.name === `boxalarm-dev-alerting-${channel}-queue.fifo`,
        );
        expect(queue!.inputs.visibilityTimeoutSeconds).toBe(2 * (worker.inputs.timeout as number));
      }
    });
  },
);

describe("RoutesOps routes set an explicit 10s timeout", { timeout: 30_000 }, () => {
  it("every routes-ops Lambda (authorized routes and vendor webhooks) → 10s", async () => {
    installMocks({
      "boxalarm-infra:smsWebhookSecret": "s",
      "boxalarm-infra:voiceWebhookSecret": "v",
      "boxalarm-infra:pushWebhookSecret": "p",
    });
    const logGroup = new ServiceLogGroup("alerting-lg", {
      env: "dev",
      serviceName: "alerting-service",
    });
    const httpApi = new HttpApi("http-api", {
      env: "dev",
      userPoolId: "pool-1",
      allowedClientIds: ["client-1"],
      platformLogGroup: new ServiceLogGroup("platform-lg", {
        env: "dev",
        serviceName: "platform-service",
      }),
    });
    new RoutesOps("routes-ops", {
      env: "dev",
      httpApi,
      alertingTableArn: TABLE_ARN,
      alertingCmkArn: CMK_ARN,
      alertingTableName: "boxalarm-dev-alerting-table",
      logGroup,
      policyStoreId: "policy-store-id",
      permissionsBoundaryArn: BOUNDARY_ARN,
    });
    await settle();
    const opsLambdas = resourcesOfType("aws:lambda/function:Function").filter((fn) =>
      (fn.name as string).startsWith("routes-ops-"),
    );
    expect(ROUTES_OPS_TIMEOUT_SECONDS).toBe(10);
    expect(opsLambdas).toHaveLength(12);
    for (const fn of opsLambdas) {
      expect(fn.inputs.timeout, fn.inputs.name as string).toBe(ROUTES_OPS_TIMEOUT_SECONDS);
    }
  });
});

describe(
  "paging-path Lambdas set explicit memory (not the 128 MB default)",
  { timeout: 30_000 },
  () => {
    it("fan-out, escalation, tone-evaluator and every channel worker → 512 MB", async () => {
      await buildSchedulingChain();
      const messaging = new MessagingAlerting("messaging-alerting", { env: "dev" });
      new ChannelWorkers("channel-workers", {
        env: "dev",
        alertingTableArn: TABLE_ARN,
        alertingCmkArn: CMK_ARN,
        alertingTableName: "boxalarm-dev-alerting-table",
        channelQueues: messaging.channelQueues,
        logGroup: new ServiceLogGroup("alerting-lg-2", {
          env: "dev",
          serviceName: "alerting-service",
        }),
        permissionsBoundaryArn: BOUNDARY_ARN,
      });
      await settle();
      expect(ALERT_PATH_MEMORY_MB).toBe(512);
      for (const functionName of [
        "boxalarm-dev-alerting-fan-out",
        "boxalarm-dev-alerting-escalation",
        "boxalarm-dev-alerting-tone-evaluator",
        "boxalarm-dev-alerting-push-worker",
        "boxalarm-dev-alerting-sms-worker",
        "boxalarm-dev-alerting-voice-worker",
      ]) {
        expect(lambdaByName(functionName).inputs.memorySize, functionName).toBe(512);
      }
    });
  },
);
