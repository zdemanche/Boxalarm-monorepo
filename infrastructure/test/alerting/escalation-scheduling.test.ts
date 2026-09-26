import { beforeEach, describe, expect, it } from "vitest";
import {
  SCHEDULING_LAMBDAS,
  buildSchedulingChain,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  statementsForRole,
} from "./mock-harness";

beforeEach(() => {
  installMocks();
});

describe(
  "Escalation schedule group — IAM scope and CreateSchedule GroupName agree",
  { timeout: 30_000 },
  () => {
    it.each(SCHEDULING_LAMBDAS)(
      "%s is told the dedicated group and may create schedules only inside it",
      async (functionName) => {
        await buildSchedulingChain();
        const [group] = resourcesOfType("aws:scheduler/scheduleGroup:ScheduleGroup");
        const groupName = group!.inputs.name as string;
        expect(groupName).toBe("boxalarm-dev-alerting-escalation");

        expect(lambdaEnv(functionName).ESCALATION_SCHEDULE_GROUP_NAME).toBe(groupName);

        const statements = statementsForRole(functionName);
        expect(
          isGranted(
            statements,
            "scheduler:CreateSchedule",
            `arn:aws:scheduler:us-east-1:123456789012:schedule/${groupName}/*`,
          ),
        ).toBe(true);
        // Least privilege: nothing grants the implicit `default` group.
        expect(
          isGranted(statements, "scheduler:CreateSchedule", (r) => r.includes("schedule/default/")),
        ).toBe(false);
      },
    );
  },
);
