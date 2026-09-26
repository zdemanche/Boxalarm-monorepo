import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { RidingBoard } from "../../components/alerting/riding-board";
import { installMocks, isGranted, settle, statementsForRole } from "./mock-harness";

const PLATFORM_TABLE_ARN =
  "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-platform-table";
const GSI3_ARN = `${PLATFORM_TABLE_ARN}/index/GSI3`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const platformLogGroup = new ServiceLogGroup("platform-lg", {
    env: "dev",
    serviceName: "platform-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup,
  });
  new RidingBoard("riding-board", {
    env: "dev",
    httpApi,
    // An Output, as index.ts passes it — proves the index ARN is resolved, not stringified.
    platformTableArn: pulumi.output(PLATFORM_TABLE_ARN),
    platformTableName: "boxalarm-dev-platform-table",
    logGroup: new ServiceLogGroup("apparatus-lg", { env: "dev", serviceName: "apparatus-service" }),
    policyStoreId: "policy-store-id",
  });
  await settle();
}

describe(
  "RidingBoard IAM matches apparatus-service ridingBoard's DynamoDB calls",
  { timeout: 30_000 },
  () => {
    it("GET can Query GSI3 (listApparatusForBoard) plus Get/Query the table", async () => {
      await build();
      const statements = statementsForRole("boxalarm-dev-apparatus-riding-board-get");
      expect(isGranted(statements, "dynamodb:Query", GSI3_ARN)).toBe(true);
      expect(isGranted(statements, "dynamodb:GetItem", PLATFORM_TABLE_ARN)).toBe(true);
      expect(isGranted(statements, "dynamodb:Query", PLATFORM_TABLE_ARN)).toBe(true);
      expect(isGranted(statements, "dynamodb:UpdateItem", PLATFORM_TABLE_ARN)).toBe(false);
    });

    it("assign can Query GSI3 (findApparatusItem) and perform every item of assignSeat's transaction", async () => {
      await build();
      const statements = statementsForRole("boxalarm-dev-apparatus-riding-board-assign");
      expect(isGranted(statements, "dynamodb:Query", GSI3_ARN)).toBe(true);
      for (const action of [
        "dynamodb:GetItem",
        "dynamodb:ConditionCheckItem",
        "dynamodb:UpdateItem",
        "dynamodb:PutItem",
      ]) {
        expect(isGranted(statements, action, PLATFORM_TABLE_ARN), action).toBe(true);
      }
    });
  },
);
