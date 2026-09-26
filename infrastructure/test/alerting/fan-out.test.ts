import { beforeEach, describe, expect, it } from "vitest";
import {
  STREAM_ARN,
  esmFor,
  buildSchedulingChain,
  installMocks,
  isGranted,
  lambdaEnv,
  statementsForRole,
} from "./mock-harness";

const FAN_OUT = "boxalarm-dev-alerting-fan-out";

beforeEach(() => {
  installMocks();
});

const build = buildSchedulingChain;

describe("FanOut — escalation scheduling wiring", { timeout: 30_000 }, () => {
  it("sets every env var the stream path's escalation + tone-ladder scheduling requires", async () => {
    await build();
    const env = lambdaEnv(FAN_OUT);
    expect(env.ESCALATION_HANDLER_ARN).toBe(
      "arn:aws:lambda:us-east-1:123456789012:function:boxalarm-dev-alerting-escalation",
    );
    expect(env.ESCALATION_SCHEDULER_ROLE_ARN).toBe(
      "arn:aws:iam::123456789012:role/boxalarm-dev-alerting-escalation-scheduler",
    );
    expect(env.TONE_EVALUATOR_HANDLER_ARN).toBe(
      "arn:aws:lambda:us-east-1:123456789012:function:boxalarm-dev-alerting-tone-evaluator",
    );
  });

  it("reports per-record batch failures, bisects, and bounds retries into an on-failure queue", async () => {
    await build();
    const esm = esmFor(FAN_OUT).inputs;
    expect(esm.functionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    expect(esm.bisectBatchOnFunctionError).toBe(true);
    expect(esm.maximumRetryAttempts).toBe(3);
    expect(esm.maximumRecordAgeInSeconds).toBe(900);
    const onFailureArn =
      "arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-fan-out-onfailure";
    expect(esm.destinationConfig).toEqual({ onFailure: { destinationArn: onFailureArn } });
    expect(isGranted(statementsForRole(FAN_OUT), "sqs:SendMessage", onFailureArn)).toBe(true);
  });

  it("can read the alerting-table stream its event source mapping polls", async () => {
    await build();
    const statements = statementsForRole(FAN_OUT);
    for (const action of [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
    ]) {
      expect(isGranted(statements, action, STREAM_ARN)).toBe(true);
    }
    expect(isGranted(statements, "dynamodb:ListStreams", "*")).toBe(true);
  });
});
