import { beforeEach, describe, expect, it } from "vitest";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { AlertingCanary } from "../../components/alerting/canary";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  alarmByName,
  installMocks,
  isGranted,
  resourcesOfType,
  settle,
  statementsForRole,
} from "./mock-harness";

const PAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";

beforeEach(() => {
  installMocks({ "boxalarm-infra:canaryMemberId": "test-canary-member" });
});

function scheduleInputs(): Record<string, unknown> {
  const schedule = resourcesOfType("aws:scheduler/schedule:Schedule").find(
    (r) => r.inputs.name === "boxalarm-dev-alerting-nichols-fd-canary",
  );
  if (!schedule) throw new Error("no canary schedule");
  return schedule.inputs;
}

async function build() {
  const canary = new AlertingCanary("canary", {
    env: "dev",
    deptId: "nichols-fd",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    pageTopicArn: PAGE_TOPIC_ARN,
    logGroup: new ServiceLogGroup("alerting-lg", { env: "dev", serviceName: "alerting-service" }),
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
  return canary;
}

describe(
  "AlertingCanary IAM covers every DynamoDB call the canary Lambda makes",
  { timeout: 30_000 },
  () => {
    // canary/handler.ts → canaryRunRepository (Get/Put/Delete), selfTestRunRepository
    // (Get/Put), dispatches/repository.createManualDispatch (TransactWriteCommand of Puts).
    const REPOSITORY_OPERATIONS = {
      "getCanaryPointer / getSelfTestRun": "dynamodb:GetItem",
      "setCanaryPointer / putCanaryRun / upsertSelfTestRun / acquireSelfTestCooldown":
        "dynamodb:PutItem",
      clearCanaryPointer: "dynamodb:DeleteItem",
      "createManualDispatch (transaction)": "dynamodb:TransactWriteItems",
      "createManualDispatch (transaction Put items)": "dynamodb:PutItem",
    } as const;

    for (const [operation, action] of Object.entries(REPOSITORY_OPERATIONS)) {
      it(`grants ${action} on the alerting table for ${operation}`, async () => {
        await build();
        const statements = statementsForRole("boxalarm-dev-alerting-canary");
        expect(isGranted(statements, action, TABLE_ARN)).toBe(true);
      });
    }
  },
);

describe("AlertingCanary schedule is config-driven per stack", { timeout: 30_000 }, () => {
  const ALARMS = [
    "boxalarm-dev-alerting-canary-failed",
    "boxalarm-dev-alerting-canary-latency-high",
  ];

  it("defaults OFF: schedule DISABLED and its breaching-on-missing alarms do not page", async () => {
    await build();
    expect(scheduleInputs().state).toBe("DISABLED");
    for (const alarm of ALARMS) {
      expect(alarmByName(alarm).inputs.actionsEnabled, alarm).toBe(false);
    }
  });

  it("runs only when the stack sets canaryEnabled=true, at the configured rate", async () => {
    installMocks({
      "boxalarm-infra:canaryMemberId": "test-canary-member",
      "boxalarm-infra:canaryEnabled": "true",
      "boxalarm-infra:canaryScheduleRateMinutes": "5",
    });
    await build();
    expect(scheduleInputs().state).toBe("ENABLED");
    expect(scheduleInputs().scheduleExpression).toBe("rate(5 minutes)");
    for (const alarm of ALARMS) {
      expect(alarmByName(alarm).inputs.actionsEnabled, alarm).toBe(true);
      expect(alarmByName(alarm).inputs.alarmActions).toEqual([PAGE_TOPIC_ARN]);
    }
  });
});

describe("AlertingCanary pages on its own Lambda Errors", { timeout: 30_000 }, () => {
  it("routes the canary Errors alarm to the page topic", async () => {
    await build();
    const alarm = alarmByName("boxalarm-dev-alerting-canary-errors").inputs;
    expect(alarm.namespace).toBe("AWS/Lambda");
    expect(alarm.metricName).toBe("Errors");
    expect(alarm.dimensions).toEqual({ FunctionName: "boxalarm-dev-alerting-canary" });
    expect(alarm.alarmActions).toEqual([PAGE_TOPIC_ARN]);
  });
});
