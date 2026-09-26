import { beforeEach, describe, expect, it } from "vitest";
import {
  TABLE_ARN,
  buildSchedulingChain,
  installMocks,
  isGranted,
  statementsForRole,
} from "./mock-harness";

const INGRESS = "boxalarm-dev-alerting-dispatches-create";

beforeEach(() => {
  installMocks();
});

describe(
  "RoutesCore dispatch-ingress IAM matches runFanOut's DynamoDB calls",
  { timeout: 30_000 },
  () => {
    it.each([
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:TransactWriteItems",
      "dynamodb:PutItem",
    ])("grants %s on the alerting table", async (action) => {
      await buildSchedulingChain();
      expect(isGranted(statementsForRole(INGRESS), action, TABLE_ARN)).toBe(true);
    });
  },
);
