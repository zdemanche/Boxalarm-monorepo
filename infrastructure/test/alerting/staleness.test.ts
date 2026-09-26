import { beforeEach, describe, expect, it } from "vitest";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { EligibilityStaleness } from "../../components/alerting/staleness";
import {
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  alarmByName,
  installMocks,
  resourcesOfType,
  settle,
} from "./mock-harness";

const PAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";

beforeEach(() => {
  installMocks();
});

async function build() {
  const staleness = new EligibilityStaleness("staleness", {
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
  return staleness;
}

describe("EligibilityStaleness", { timeout: 30_000 }, () => {
  it("puts the scheduler role under the alerting-plane permissions boundary", async () => {
    await build();
    const role = resourcesOfType("aws:iam/role:Role").find(
      (r) => r.inputs.name === "boxalarm-dev-alerting-staleness-scheduler",
    );
    expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
  });

  it("keeps the SnapshotStale alarm dashboard-only (no page) until the backend metric is fixed", async () => {
    await build();
    const alarm = alarmByName("boxalarm-dev-alerting-eligibility-snapshot-stale");
    expect(alarm.inputs.alarmActions ?? []).toEqual([]);
  });

  it("pages on the staleness Lambda's own Errors (the stale alarm goes silent if it throws)", async () => {
    await build();
    const alarm = alarmByName("boxalarm-dev-alerting-eligibility-staleness-check-errors").inputs;
    expect(alarm.namespace).toBe("AWS/Lambda");
    expect(alarm.metricName).toBe("Errors");
    expect(alarm.dimensions).toEqual({
      FunctionName: "boxalarm-dev-alerting-eligibility-staleness-check",
    });
    expect(alarm.alarmActions).toEqual([PAGE_TOPIC_ARN]);
  });
});
