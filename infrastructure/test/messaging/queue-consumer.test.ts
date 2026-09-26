import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import type * as aws from "@pulumi/aws";

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

describe("QueueConsumer", () => {
  async function build(extra: { reportBatchItemFailures?: boolean } = {}) {
    const { QueueConsumer } = await import("../../components/messaging/queue-consumer");
    const awsMod = await import("@pulumi/aws");
    const role = new awsMod.iam.Role("consumer-role", { assumeRolePolicy: "{}" });
    const fn = { name: pulumi.output("consumer-fn") } as unknown as aws.lambda.Function;
    return new QueueConsumer("test-consumer", {
      env: "dev",
      busName: pulumi.output("boxalarm-dev-platform-bus"),
      busArn: pulumi.output(
        "arn:aws:events:us-east-1:123456789012:event-bus/boxalarm-dev-platform-bus",
      ),
      ruleName: "boxalarm-dev-test-rule",
      eventPattern: JSON.stringify({ "detail-type": ["personnel.member.updated"] }),
      queueName: "boxalarm-dev-test-queue",
      lambda: fn,
      lambdaRole: role,
      ...extra,
    });
  }

  async function settle(consumer: Awaited<ReturnType<typeof build>>): Promise<void> {
    await Promise.all([
      resolve(consumer.queue.arn),
      resolve(consumer.dlq.arn),
      resolve(consumer.rule.arn),
      resolve(consumer.target.id),
      resolve(consumer.eventSourceMapping.id),
      resolve(consumer.dlqDepthAlarm.id),
    ]);
  }

  it("wires a DLQ with redrive from the main queue", async () => {
    const consumer = await build();
    await settle(consumer);
    const [redrive, dlqName] = await Promise.all([
      resolve(consumer.queue.redrivePolicy),
      resolve(consumer.dlq.name),
    ]);
    const parsed = JSON.parse(redrive as string) as {
      maxReceiveCount: number;
      deadLetterTargetArn: string;
    };
    expect(parsed.maxReceiveCount).toBe(5);
    expect(dlqName).toBe("boxalarm-dev-test-queue-dlq");
  });

  it("scopes the EventBridge send permission to this bus (confused-deputy hardening)", async () => {
    const consumer = await build();
    await settle(consumer);
    const policy = await resolve(consumer.queue.id);
    expect(policy).toBeDefined();
    const rulePattern = await resolve(consumer.rule.eventPattern);
    expect(rulePattern).toContain("personnel.member.updated");
  });

  it("caps the event source mapping's concurrency so a burst can't consume alerting-service's shared Lambda concurrency pool", async () => {
    const consumer = await build();
    await settle(consumer);
    const scalingConfig = await resolve(consumer.eventSourceMapping.scalingConfig);
    expect(scalingConfig?.maximumConcurrency).toBeGreaterThanOrEqual(2);
  });

  it("leaves ReportBatchItemFailures off by default so throw-to-fail handlers keep their semantics", async () => {
    const consumer = await build();
    await settle(consumer);
    const responseTypes = await resolve(consumer.eventSourceMapping.functionResponseTypes);
    expect(responseTypes ?? []).not.toContain("ReportBatchItemFailures");
  });

  it("sets ReportBatchItemFailures when a batchItemFailures-returning handler opts in", async () => {
    const consumer = await build({ reportBatchItemFailures: true });
    await settle(consumer);
    const responseTypes = await resolve(consumer.eventSourceMapping.functionResponseTypes);
    expect(responseTypes).toEqual(["ReportBatchItemFailures"]);
  });

  it("alarms on DLQ depth above zero", async () => {
    const consumer = await build();
    await settle(consumer);
    const [threshold, comparison] = await Promise.all([
      resolve(consumer.dlqDepthAlarm.threshold),
      resolve(consumer.dlqDepthAlarm.comparisonOperator),
    ]);
    expect(threshold).toBe(0);
    expect(comparison).toBe("GreaterThanThreshold");
  });
});
