import {
  SchedulerClient,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
} from '@aws-sdk/client-scheduler';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { readScheduleGroupName } from './scheduleEscalation.js';

export const TONE_SEQUENCE_TWO = 2;
export const TONE_SEQUENCE_THREE = 3;
export const MUTUAL_AID_AFTER_TONE = TONE_SEQUENCE_THREE;

const DEFAULT_TONE_2_AT_SECONDS = 180;
const DEFAULT_TONE_3_AT_SECONDS = 360;
const DEFAULT_MIN_RESPONDERS = 1;
const DEFAULT_REQUIRED_QUALS: readonly string[] = [];

export interface DepartmentToneConfig {
  readonly tone2AtSeconds: number;
  readonly tone3AtSeconds: number;
  readonly minResponders: number;
  readonly requiredQuals: readonly string[];
}

export async function readDepartmentToneConfig(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<DepartmentToneConfig> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'ALERT_RULES'), sk: 'METADATA' },
    }),
  );
  const toneLadder = result.Item?.toneLadder as Record<string, unknown> | undefined;
  const defaultRule = result.Item?.defaultRule as Record<string, unknown> | undefined;
  return {
    tone2AtSeconds:
      typeof toneLadder?.tone2AtSeconds === 'number'
        ? toneLadder.tone2AtSeconds
        : DEFAULT_TONE_2_AT_SECONDS,
    tone3AtSeconds:
      typeof toneLadder?.tone3AtSeconds === 'number'
        ? toneLadder.tone3AtSeconds
        : DEFAULT_TONE_3_AT_SECONDS,
    minResponders:
      typeof defaultRule?.minResponders === 'number'
        ? defaultRule.minResponders
        : DEFAULT_MIN_RESPONDERS,
    requiredQuals: Array.isArray(defaultRule?.requiredQuals)
      ? (defaultRule.requiredQuals as readonly string[])
      : DEFAULT_REQUIRED_QUALS,
  };
}

export interface ToneEvaluatorSchedulerConfig {
  readonly toneEvaluatorHandlerArn: string;
  readonly schedulerRoleArn: string;
  readonly scheduleGroupName: string;
}

export function readToneEvaluatorSchedulerConfig(
  env: NodeJS.ProcessEnv,
): ToneEvaluatorSchedulerConfig {
  const toneEvaluatorHandlerArn = env.TONE_EVALUATOR_HANDLER_ARN;
  const schedulerRoleArn = env.ESCALATION_SCHEDULER_ROLE_ARN;
  if (!toneEvaluatorHandlerArn) {
    throw new Error('TONE_EVALUATOR_HANDLER_ARN is required and was not set');
  }
  if (!schedulerRoleArn) {
    throw new Error('ESCALATION_SCHEDULER_ROLE_ARN is required and was not set');
  }
  return {
    toneEvaluatorHandlerArn,
    schedulerRoleArn,
    scheduleGroupName: readScheduleGroupName(env),
  };
}

async function createToneSchedule(
  scheduler: SchedulerClient,
  config: ToneEvaluatorSchedulerConfig,
  deptId: VerifiedDeptId,
  dispatchId: string,
  toneSequence: number,
  delaySeconds: number,
): Promise<void> {
  const fireAt = Math.floor(Date.now() / 1000) + delaySeconds;
  const scheduleName = `tone-${deptId}-${dispatchId}-${toneSequence}`.slice(0, 64);
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: scheduleName,
        GroupName: config.scheduleGroupName,
        ScheduleExpression: `at(${new Date(fireAt * 1000).toISOString().slice(0, 19)})`,
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        Target: {
          Arn: config.toneEvaluatorHandlerArn,
          RoleArn: config.schedulerRoleArn,
          Input: JSON.stringify({ deptId, dispatchId, toneSequence }),
        },
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ConflictException') {
      return;
    }
    throw error;
  }
}

export async function scheduleDepartmentToneLadder(
  scheduler: SchedulerClient,
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<void> {
  const config = readToneEvaluatorSchedulerConfig(process.env);
  const toneConfig = await readDepartmentToneConfig(ddb, tableName, deptId);
  await createToneSchedule(
    scheduler,
    config,
    deptId,
    dispatchId,
    TONE_SEQUENCE_TWO,
    toneConfig.tone2AtSeconds,
  );
  await createToneSchedule(
    scheduler,
    config,
    deptId,
    dispatchId,
    TONE_SEQUENCE_THREE,
    toneConfig.tone3AtSeconds,
  );
}

export interface RosterAckLike {
  readonly ackStatus: string;
  readonly quals: readonly string[];
}

export function isPredicateMet(
  roster: readonly RosterAckLike[],
  config: Pick<DepartmentToneConfig, 'minResponders' | 'requiredQuals'>,
): boolean {
  const responders = roster.filter(
    (entry) => entry.ackStatus === 'RESPONDING' || entry.ackStatus === 'DIRECT_TO_SCENE',
  );
  const qualifying =
    config.requiredQuals.length === 0
      ? responders
      : responders.filter((entry) =>
          entry.quals.some((qual) => config.requiredQuals.includes(qual)),
        );
  return qualifying.length >= config.minResponders;
}
