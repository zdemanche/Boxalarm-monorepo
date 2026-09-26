import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { Certifications } from "../../components/training/certifications";
import { Events } from "../../components/training/events";
import { Hours } from "../../components/training/hours";
import { Reports } from "../../components/training/reports";
import { Transcript } from "../../components/training/transcript";
import {
  ACCOUNT_ID,
  REGION,
  alarmByName,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

/**
 * #327 review (MIN-8): each training Lambda's env keys and IAM grants, asserted against
 * what its backend handler actually reads and calls — including the index ARNs its
 * queries need, which a table-only grant silently denies.
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const GSI1 = `${TABLE}/index/GSI1`;
const GSI2 = `${TABLE}/index/GSI2`;
const GSI3 = `${TABLE}/index/GSI3`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("training-lg", {
    env: "dev",
    serviceName: "training-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: logGroup,
  });
  const common = {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    // An Output, as index.ts passes it — proves index ARNs are resolved, not stringified.
    platformTableArn: pulumi.output(TABLE),
    policyStoreArn: `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/ps-1`,
    policyStoreId: "ps-1",
    logGroup,
    httpApi,
  };
  new Certifications("certifications", {
    ...common,
    deptId: "nichols-fd",
    platformBusName: "boxalarm-dev-platform-bus",
    platformBusArn: `arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/boxalarm-dev-platform-bus`,
    platformTableStreamArn: `${TABLE}/stream/2026-01-01T00:00:00.000`,
  });
  new Events("events", common);
  new Hours("hours", common);
  new Reports("reports", common);
  new Transcript("transcript", common);
  await settle();
}

describe("training Lambdas: env and IAM match their handlers", { timeout: 30_000 }, () => {
  describe("certifications", () => {
    it("expiring can GetItem the lead-time config and Query GSI2, and nothing else", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-certifications-expiring");
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI2)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(false);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(false);
    });

    it("the expiry scanner can Query GSI2 and write its dedup marker", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-cert-expiry-scanner");
      expect(isGranted(s, "dynamodb:Query", GSI2)).toBe(true);
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
      expect(isGranted(s, "events:PutEvents", (r) => r.includes("event-bus/"))).toBe(true);
    });
  });

  describe("events", () => {
    it("list can Query GSI3 (events) and GSI1 (my signups) and holds no write action", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-events-list");
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI1)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(false);
    });

    it("signup can GetItem the event, PutItem a self-signup and UpdateItem officer attendance", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-events-signup");
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
    });
  });

  describe("hours", () => {
    it("can Query GSI1 (member path), GSI3 and the base table (roster path)", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-hours");
      expect(isGranted(s, "dynamodb:Query", GSI1)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
    });
  });

  describe("reports", () => {
    it("ISO report can Query GSI3 (events in period) and the base table (attendees)", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-reports-iso");
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
    });
  });

  describe("transcript", () => {
    it("can Query the base table (certifications) and GSI1 (attendance history)", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-transcript-get");
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI1)).toBe(true);
    });
  });

  describe("cert-expiry scanner schedule (MAJ-5)", () => {
    it("retries, dead-letters to a DLQ the scheduler role can write, and alarms", async () => {
      await build();
      const schedule = resourcesOfType("aws:scheduler/schedule:Schedule").find(
        (r) => r.inputs.name === "boxalarm-dev-training-cert-expiry-scanner-daily",
      );
      const target = schedule?.inputs.target as {
        retryPolicy?: { maximumRetryAttempts: number };
        deadLetterConfig?: { arn: string };
      };
      expect(target.retryPolicy?.maximumRetryAttempts).toBe(3);
      const dlqArn = `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:boxalarm-dev-training-cert-expiry-scanner-dlq`;
      expect(target.deadLetterConfig?.arn).toBe(dlqArn);

      const schedulerStatements = statementsForRole("boxalarm-dev-training-cert-expiry-scheduler");
      expect(isGranted(schedulerStatements, "sqs:SendMessage", dlqArn)).toBe(true);

      const dlqAlarm = alarmByName("boxalarm-dev-training-cert-expiry-scanner-dlq-depth");
      expect(dlqAlarm.inputs.threshold).toBe(0);
      const errors = alarmByName("boxalarm-dev-training-cert-expiry-scanner-errors");
      expect(errors.inputs.metricName).toBe("Errors");
      expect(errors.inputs.dimensions).toEqual({
        FunctionName: "boxalarm-dev-training-cert-expiry-scanner",
      });
    });
  });

  describe("least privilege (MIN-2)", () => {
    const WRITES = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"];

    it("certifications create holds PutItem only", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-certifications-create");
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      for (const action of ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
    });

    it("certifications list holds base-table Query only", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-certifications-list");
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
      for (const action of [...WRITES, "dynamodb:GetItem"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
    });

    it("certifications revoke holds GetItem + UpdateItem + PutItem, no Query", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-certifications-revoke");
      for (const action of ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"]) {
        expect(isGranted(s, action, TABLE), action).toBe(true);
      }
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(false);
    });

    it("events create holds PutItem only", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-training-events-create");
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(false);
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(false);
    });
  });

  it("every role holding UpdateItem/DeleteItem on the platform table carries the audit-row deny (MIN-3)", async () => {
    await build();
    const roles = resourcesOfType("aws:iam/role:Role").map((r) => r.inputs.name as string);
    const mutating = roles.filter((role) => {
      const s = statementsForRole(role);
      return (
        isGranted(s, "dynamodb:UpdateItem", TABLE) || isGranted(s, "dynamodb:DeleteItem", TABLE)
      );
    });
    expect(mutating.length).toBeGreaterThan(0);
    for (const role of mutating) {
      const deny = statementsForRole(role).find((st) => st.Sid === "DenyAuditMutations");
      expect(deny?.Effect, role).toBe("Deny");
    }
  });

  // Env keys each handler's config readers require on its live path (traced from the
  // bundled handler: readTrainingConfig, readTrainingDynamoConfig,
  // readPlatformConfigDynamoConfig, readPlatformEventBusConfig, readScannerDeptId,
  // readPersonnelServiceConfig, and @boxalarm/authz's readAuthzConfig). The
  // certifications-create CloudFront variables are deliberately absent — see the
  // certifications.ts docstring (attachment uploads fail closed with a 503).
  const VP = "VERIFIED_PERMISSIONS_POLICY_STORE_ID";
  const REQUIRED_ENV: Record<string, string[]> = {
    "boxalarm-dev-training-certifications-create": ["TRAINING_DYNAMO_TABLE_NAME", VP],
    "boxalarm-dev-training-certifications-list": ["TRAINING_DYNAMO_TABLE_NAME", VP],
    "boxalarm-dev-training-certifications-revoke": ["TRAINING_DYNAMO_TABLE_NAME", VP],
    "boxalarm-dev-training-certifications-expiring": [
      "TRAINING_DYNAMO_TABLE_NAME",
      "PLATFORM_CONFIG_DYNAMO_TABLE_NAME",
      VP,
    ],
    "boxalarm-dev-training-cert-expiry-scanner": [
      "TRAINING_DYNAMO_TABLE_NAME",
      "PLATFORM_CONFIG_DYNAMO_TABLE_NAME",
      "PLATFORM_EVENT_BUS_NAME",
      "TRAINING_SCANNER_DEPT_ID",
    ],
    "boxalarm-dev-personnel-cert-expired-reactor": ["PERSONNEL_TABLE_NAME", "PLATFORM_BUS_NAME"],
    "boxalarm-dev-training-events-create": ["TRAINING_TABLE_NAME", VP],
    "boxalarm-dev-training-events-list": ["TRAINING_TABLE_NAME"],
    "boxalarm-dev-training-events-signup": ["TRAINING_TABLE_NAME", VP],
    "boxalarm-dev-training-hours": ["TRAINING_TABLE_NAME", VP],
    "boxalarm-dev-training-reports-iso": ["TRAINING_TABLE_NAME", VP],
    "boxalarm-dev-training-transcript-get": [
      "TRAINING_TABLE_NAME",
      "TRAINING_DYNAMO_TABLE_NAME",
      VP,
    ],
  };

  it.each(Object.entries(REQUIRED_ENV))(
    "%s carries every env key its handler requires",
    async (fn, keys) => {
      await build();
      const env = lambdaEnv(fn);
      for (const key of keys) {
        expect(env[key], `${fn} ${key}`).toBeTruthy();
      }
    },
  );

  it("every Cedar-gated training Lambda can call Verified Permissions", async () => {
    await build();
    for (const [fn, keys] of Object.entries(REQUIRED_ENV)) {
      if (!keys.includes(VP)) {
        continue;
      }
      expect(
        isGranted(statementsForRole(fn), "verifiedpermissions:IsAuthorizedWithToken", (r) =>
          r.includes("policy-store"),
        ),
        fn,
      ).toBe(true);
    }
  });

  it("the cert-expired reactor can Query and Update/Put the platform table (qual flip + outbox)", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-personnel-cert-expired-reactor");
    for (const action of ["dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:PutItem"]) {
      expect(isGranted(s, action, TABLE), action).toBe(true);
    }
  });
});
