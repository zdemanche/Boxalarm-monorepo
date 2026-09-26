import { beforeEach, describe, expect, it } from "vitest";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { MessagingAlerting } from "../../components/alerting/messaging-alerting";
import { ChannelWorkers } from "../../components/alerting/channel-workers";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  esmFor,
  installMocks,
  lambdaByName,
  isGranted,
  lambdaEnv,
  settle,
  statementsForRole,
} from "./mock-harness";

beforeEach(() => {
  installMocks();
});

async function buildWorkers() {
  const logGroup = new ServiceLogGroup("alerting-lg", {
    env: "dev",
    serviceName: "alerting-service",
  });
  const messaging = new MessagingAlerting("messaging-alerting", { env: "dev" });
  const workers = new ChannelWorkers("channel-workers", {
    env: "dev",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    channelQueues: messaging.channelQueues,
    logGroup,
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
  return { messaging, workers };
}

const queueArn = (channel: string) =>
  `arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-${channel}-queue.fifo`;

describe("ChannelWorkers — each worker can drain only its own queue", { timeout: 30_000 }, () => {
  it.each(["push", "sms", "voice"])("%s worker", async (channel) => {
    await buildWorkers();
    const statements = statementsForRole(`boxalarm-dev-alerting-${channel}-worker`);
    for (const action of ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]) {
      expect(isGranted(statements, action, queueArn(channel))).toBe(true);
    }
    for (const other of ["push", "sms", "voice"].filter((c) => c !== channel)) {
      expect(isGranted(statements, "sqs:ReceiveMessage", queueArn(other))).toBe(false);
    }
  });
});

describe("ChannelWorkers — placeholder provider endpoints", { timeout: 30_000 }, () => {
  it.each(["push", "sms", "voice"])(
    "%s worker's default endpoint is on the RFC 2606 reserved .invalid TLD",
    async (channel) => {
      await buildWorkers();
      const url = new URL(
        lambdaEnv(`boxalarm-dev-alerting-${channel}-worker`)[
          `${channel.toUpperCase()}_PROVIDER_ENDPOINT_URL`
        ]!,
      );
      expect(url.protocol).toBe("https:");
      expect(url.hostname.endsWith(".invalid")).toBe(true);
    },
  );
});

describe("ChannelWorkers — sandbox credentials reach each worker", { timeout: 30_000 }, () => {
  it.each(["push", "sms", "voice"])(
    "%s worker gets its own prod and sandbox secret IDs, and can read both",
    async (channel) => {
      await buildWorkers();
      const upper = channel.toUpperCase();
      const env = lambdaEnv(`boxalarm-dev-alerting-${channel}-worker`);
      expect(env[`${upper}_PROVIDER_SECRET_ID`]).toBe(
        `boxalarm-dev-alerting-${channel}-provider-credentials`,
      );
      expect(env[`${upper}_PROVIDER_SANDBOX_SECRET_ID`]).toBe(
        `boxalarm-dev-alerting-${channel}-provider-sandbox-credentials`,
      );
      const statements = statementsForRole(`boxalarm-dev-alerting-${channel}-worker`);
      const sandboxArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:boxalarm-dev-alerting-${channel}-provider-sandbox-credentials`;
      expect(isGranted(statements, "secretsmanager:GetSecretValue", sandboxArn)).toBe(true);
    },
  );
});

describe(
  "ChannelWorkers — SQS ESM concurrency matches reserved concurrency",
  { timeout: 30_000 },
  () => {
    it.each(["push", "sms", "voice"])("%s worker", async (channel) => {
      await buildWorkers();
      const functionName = `boxalarm-dev-alerting-${channel}-worker`;
      const reserved = lambdaByName(functionName).inputs.reservedConcurrentExecutions as number;
      expect(reserved).toBe(5);
      expect(esmFor(functionName).inputs.scalingConfig).toEqual({ maximumConcurrency: reserved });
    });
  },
);
