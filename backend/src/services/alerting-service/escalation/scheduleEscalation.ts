import {
  SchedulerClient,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
} from '@aws-sdk/client-scheduler';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import AWSXRay from 'aws-xray-sdk-core';
import { logInfo } from '../dispatches/logger.js';

const DEFAULT_ESCALATION_THRESHOLD_SECONDS = 75;

export interface EscalationSchedulerConfig {
  readonly escalationHandlerArn: string;
  readonly schedulerRoleArn: string;
  readonly scheduleGroupName: string;
}

/**
 * The dedicated EventBridge Scheduler group infra provisions for alerting timers
 * (`boxalarm-{env}-alerting-escalation`). Every scheduler:CreateSchedule grant is
 * scoped to `schedule/<this group>/*`, so a schedule created without GroupName lands
 * in the implicit `default` group and is denied.
 */
export function readScheduleGroupName(env: NodeJS.ProcessEnv): string {
  const scheduleGroupName = env.ESCALATION_SCHEDULE_GROUP_NAME;
  if (!scheduleGroupName) {
    throw new Error('ESCALATION_SCHEDULE_GROUP_NAME is required and was not set');
  }
  return scheduleGroupName;
}

export function readEscalationSchedulerConfig(env: NodeJS.ProcessEnv): EscalationSchedulerConfig {
  const escalationHandlerArn = env.ESCALATION_HANDLER_ARN;
  const schedulerRoleArn = env.ESCALATION_SCHEDULER_ROLE_ARN;
  if (!escalationHandlerArn) {
    throw new Error('ESCALATION_HANDLER_ARN is required and was not set');
  }
  if (!schedulerRoleArn) {
    throw new Error('ESCALATION_SCHEDULER_ROLE_ARN is required and was not set');
  }
  return { escalationHandlerArn, schedulerRoleArn, scheduleGroupName: readScheduleGroupName(env) };
}

let cachedSchedulerClient: SchedulerClient | undefined;

export function getSchedulerClient(client?: SchedulerClient): SchedulerClient {
  cachedSchedulerClient ??= client ?? AWSXRay.captureAWSv3Client(new SchedulerClient({}));
  return cachedSchedulerClient;
}

export async function readEscalationThresholdSeconds(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<number> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'ALERT_RULES'), sk: 'METADATA' },
    }),
  );
  const threshold = (result.Item?.toneLadder as Record<string, unknown> | undefined)
    ?.escalationThresholdSeconds;
  if (typeof threshold !== 'number') {
    logInfo('alerting.escalation.threshold_default', {
      deptId,
      escalationThresholdSeconds: DEFAULT_ESCALATION_THRESHOLD_SECONDS,
    });
    return DEFAULT_ESCALATION_THRESHOLD_SECONDS;
  }
  return threshold;
}

export interface CreateEscalationScheduleInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly toneSequence: number;
  readonly delaySeconds?: number;
}

export async function createEscalationSchedule(
  scheduler: SchedulerClient,
  input: CreateEscalationScheduleInput,
  ddb?: DynamoDBDocumentClient,
  tableName?: string,
): Promise<string> {
  const { deptId, dispatchId, memberId, toneSequence } = input;
  const config = readEscalationSchedulerConfig(process.env);
  const delaySeconds =
    input.delaySeconds ??
    (ddb && tableName
      ? await readEscalationThresholdSeconds(ddb, tableName, deptId)
      : DEFAULT_ESCALATION_THRESHOLD_SECONDS);
  const fireAt = Math.floor(Date.now() / 1000) + delaySeconds;
  const scheduleName = `esc-${deptId}-${dispatchId}-${memberId}-${toneSequence}`.slice(0, 64);

  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: scheduleName,
        GroupName: config.scheduleGroupName,
        ScheduleExpression: `at(${new Date(fireAt * 1000).toISOString().slice(0, 19)})`,
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        Target: {
          Arn: config.escalationHandlerArn,
          RoleArn: config.schedulerRoleArn,
          Input: JSON.stringify({ deptId, dispatchId, memberId, toneSequence, channel: 'voice' }),
        },
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ConflictException') {
      logInfo('alerting.escalation.schedule_already_exists', {
        deptId,
        dispatchId,
        memberId,
        toneSequence,
        scheduleName,
      });
      return scheduleName;
    }
    throw error;
  }

  return scheduleName;
}
