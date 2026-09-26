import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { PlatformBus } from "../../components/messaging/platform-bus";
import { Attendance } from "../../components/personnel/attendance";
import { Availability } from "../../components/personnel/availability";
import { Losap } from "../../components/personnel/losap";
import { Members } from "../../components/personnel/members";
import { Quals } from "../../components/personnel/quals";
import { Shifts } from "../../components/personnel/shifts";
import {
  ACCOUNT_ID,
  CMK_ARN,
  BOUNDARY_ARN,
  REGION,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

/**
 * #327 review (MIN-8): each personnel Lambda's env keys and IAM grants, asserted against
 * what its backend handler actually reads and calls (the review traced each one). Mocked
 * backend unit tests cannot see an infra/handler mismatch; these can.
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const ALERTING_TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-alerting-table`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("personnel-lg", {
    env: "dev",
    serviceName: "personnel-service",
  });
  const alertingLogGroup = new ServiceLogGroup("alerting-lg", {
    env: "dev",
    serviceName: "alerting-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: logGroup,
  });
  const platformBus = new PlatformBus("platform-bus", { env: "dev" });
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
  const alerting = {
    platformBus,
    alertingTableArn: ALERTING_TABLE,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    alertingLogGroup,
    alertingPermissionsBoundaryArn: BOUNDARY_ARN,
  };
  new Members("members", common);
  new Losap("losap", common);
  new Attendance("attendance", common);
  new Quals("quals", { ...common, ...alerting });
  new Availability("availability", { ...common, ...alerting });
  new Shifts("shifts", { ...common, deptId: "nichols-fd" });
  await settle();
}

describe("personnel Lambdas: env and IAM match their handlers", { timeout: 30_000 }, () => {
  describe("quals", () => {
    it("GET can Query the base table (readQuals) and holds no write action", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-personnel-quals-get");
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(false);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(false);
    });

    it("GET and PUT carry every env key readPersonnelServiceConfig requires", async () => {
      await build();
      for (const fn of ["boxalarm-dev-personnel-quals-get", "boxalarm-dev-personnel-quals-put"]) {
        expect(Object.keys(lambdaEnv(fn))).toEqual(
          expect.arrayContaining([
            "PERSONNEL_TABLE_NAME",
            "PLATFORM_BUS_NAME",
            "VERIFIED_PERMISSIONS_POLICY_STORE_ID",
          ]),
        );
      }
    });

    it("PUT can GetItem (member + cert lookups) and PutItem (qual + outbox transaction)", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-personnel-quals-put");
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
    });
  });

  describe("members update-profile", () => {
    it("carries PLATFORM_TABLE_NAME, the variable readMemberServiceConfig requires", async () => {
      await build();
      const env = lambdaEnv("boxalarm-dev-personnel-members-update-profile");
      expect(env.PLATFORM_TABLE_NAME).toBe("boxalarm-dev-platform-service");
      expect(env.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBe("ps-1");
    });

    it("can UpdateItem + PutItem and carries the audit-key mutation deny", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-personnel-members-update-profile");
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(s.some((st) => st.Sid === "DenyAuditMutations" && st.Effect === "Deny")).toBe(true);
    });
  });

  describe("transactions are granted item-by-item (TransactWriteItems is not an IAM action)", () => {
    const ROLES = [
      "boxalarm-dev-personnel-members-create",
      "boxalarm-dev-personnel-members-update-status",
      "boxalarm-dev-personnel-members-update-profile",
      "boxalarm-dev-personnel-quals-put",
      "boxalarm-dev-personnel-availability-create",
      "boxalarm-dev-personnel-availability-expiry",
      "boxalarm-dev-alerting-availability-changed-consumer",
      "boxalarm-dev-personnel-shifts",
      "boxalarm-dev-personnel-shift-completion",
    ];

    it("no personnel role relies on dynamodb:TransactWriteItems", async () => {
      await build();
      for (const role of ROLES) {
        const actions = statementsForRole(role).flatMap((st) =>
          Array.isArray(st.Action) ? st.Action : [st.Action],
        );
        expect(actions, role).not.toContain("dynamodb:TransactWriteItems");
      }
    });

    it("availability-changed consumer can Put (dedup) + Update (snapshot) on the alerting table", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-alerting-availability-changed-consumer");
      expect(isGranted(s, "dynamodb:PutItem", ALERTING_TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", ALERTING_TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(false);
    });

    it("shift completion can Query table + GSI3 and Put/Update the table", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-personnel-shift-completion");
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", `${TABLE}/index/GSI3`)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
    });
  });

  describe("shifts router", () => {
    it("can ConditionCheckItem (swap proposal) plus Get/Put/Update and Query table + GSI3", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-personnel-shifts");
      expect(isGranted(s, "dynamodb:ConditionCheckItem", TABLE)).toBe(true);
      for (const action of ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]) {
        expect(isGranted(s, action, TABLE), action).toBe(true);
      }
      expect(isGranted(s, "dynamodb:Query", `${TABLE}/index/GSI3`)).toBe(true);
    });
  });

  describe("availability create", () => {
    it("scopes schedule management to this account and region's avail-* schedules (MIN-1)", async () => {
      await build();
      const s = statementsForRole("boxalarm-dev-personnel-availability-create");
      const manage = s.find((st) => st.Sid === "AvailabilityManageSchedules");
      expect(manage?.Resource).toBe(
        `arn:aws:scheduler:${REGION}:${ACCOUNT_ID}:schedule/default/avail-*`,
      );
    });
  });

  describe("losap least privilege (MIN-2)", () => {
    it("member total holds base-table Query only; year-end adds GSI3 (listMembers)", async () => {
      await build();
      const total = statementsForRole("boxalarm-dev-personnel-losap-member-total");
      expect(isGranted(total, "dynamodb:Query", TABLE)).toBe(true);
      expect(isGranted(total, "dynamodb:Query", `${TABLE}/index/GSI1`)).toBe(false);
      expect(isGranted(total, "dynamodb:Query", `${TABLE}/index/GSI3`)).toBe(false);
      expect(isGranted(total, "dynamodb:GetItem", TABLE)).toBe(false);

      const yearEnd = statementsForRole("boxalarm-dev-personnel-losap-year-end-report");
      expect(isGranted(yearEnd, "dynamodb:Query", TABLE)).toBe(true);
      expect(isGranted(yearEnd, "dynamodb:Query", `${TABLE}/index/GSI3`)).toBe(true);
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
  // bundled handler: readPersonnelConfig, readAttendanceTableConfig, readMemberServiceConfig,
  // readPersonnelServiceConfig, readPersonnelDdbConfig, readSchedulerConfig,
  // readPersonnelTableConfig, readAlertingConfig, and @boxalarm/authz's readAuthzConfig).
  const VP = "VERIFIED_PERMISSIONS_POLICY_STORE_ID";
  const REQUIRED_ENV: Record<string, string[]> = {
    "boxalarm-dev-personnel-members-create": ["PERSONNEL_TABLE_NAME"],
    "boxalarm-dev-personnel-members-list": ["PERSONNEL_TABLE_NAME"],
    "boxalarm-dev-personnel-members-get": ["PERSONNEL_TABLE_NAME"],
    "boxalarm-dev-personnel-members-update-status": ["PERSONNEL_TABLE_NAME"],
    "boxalarm-dev-personnel-members-update-profile": ["PLATFORM_TABLE_NAME", VP],
    "boxalarm-dev-personnel-quals-get": ["PERSONNEL_TABLE_NAME", "PLATFORM_BUS_NAME", VP],
    "boxalarm-dev-personnel-quals-put": ["PERSONNEL_TABLE_NAME", "PLATFORM_BUS_NAME", VP],
    "boxalarm-dev-alerting-eligibility-changed-consumer": ["ALERTING_TABLE_NAME"],
    "boxalarm-dev-personnel-attendance-record": ["PLATFORM_SERVICE_TABLE_NAME", VP],
    "boxalarm-dev-personnel-attendance-record-on-behalf": ["PLATFORM_SERVICE_TABLE_NAME", VP],
    "boxalarm-dev-personnel-attendance-query": ["PLATFORM_SERVICE_TABLE_NAME", VP],
    "boxalarm-dev-personnel-attendance-query-on-behalf": ["PLATFORM_SERVICE_TABLE_NAME", VP],
    "boxalarm-dev-personnel-availability-create": [
      "PLATFORM_TABLE_NAME",
      VP,
      "AVAILABILITY_EXPIRY_HANDLER_ARN",
      "AVAILABILITY_SCHEDULER_ROLE_ARN",
    ],
    "boxalarm-dev-personnel-availability-expiry": ["PLATFORM_TABLE_NAME"],
    "boxalarm-dev-alerting-availability-changed-consumer": ["ALERTING_TABLE_NAME"],
    "boxalarm-dev-personnel-losap-member-total": ["PLATFORM_SERVICE_TABLE_NAME", VP],
    "boxalarm-dev-personnel-losap-update-rules": ["PLATFORM_SERVICE_TABLE_NAME"],
    "boxalarm-dev-personnel-losap-year-end-report": [
      "PERSONNEL_TABLE_NAME",
      "PLATFORM_SERVICE_TABLE_NAME",
    ],
    "boxalarm-dev-personnel-shifts": ["PLATFORM_TABLE_NAME", VP],
    "boxalarm-dev-personnel-shift-completion": ["PLATFORM_TABLE_NAME"],
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

  describe("attendance", () => {
    it("record (self + on-behalf) can GetItem (member, LOSAP rules) and PutItem (record + LOSAP entry)", async () => {
      await build();
      for (const fn of [
        "boxalarm-dev-personnel-attendance-record",
        "boxalarm-dev-personnel-attendance-record-on-behalf",
      ]) {
        const s = statementsForRole(fn);
        expect(isGranted(s, "dynamodb:GetItem", TABLE), fn).toBe(true);
        expect(isGranted(s, "dynamodb:PutItem", TABLE), fn).toBe(true);
        expect(isGranted(s, "dynamodb:UpdateItem", TABLE), fn).toBe(false);
      }
    });

    it("query (self + on-behalf) can Query GSI1 and GetItem the member, read-only", async () => {
      await build();
      for (const fn of [
        "boxalarm-dev-personnel-attendance-query",
        "boxalarm-dev-personnel-attendance-query-on-behalf",
      ]) {
        const s = statementsForRole(fn);
        expect(isGranted(s, "dynamodb:Query", `${TABLE}/index/GSI1`), fn).toBe(true);
        expect(isGranted(s, "dynamodb:GetItem", TABLE), fn).toBe(true);
        expect(isGranted(s, "dynamodb:PutItem", TABLE), fn).toBe(false);
      }
    });
  });

  it("every Cedar-gated personnel Lambda can call Verified Permissions", async () => {
    await build();
    for (const [fn, keys] of Object.entries(REQUIRED_ENV)) {
      if (!keys.includes(VP)) {
        continue;
      }
      const s = statementsForRole(fn);
      expect(
        isGranted(s, "verifiedpermissions:IsAuthorizedWithToken", (r) =>
          r.includes("policy-store"),
        ),
        fn,
      ).toBe(true);
    }
  });
});
