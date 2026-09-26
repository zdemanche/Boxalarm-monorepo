import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildBridgeOutboxRecord } from '../platformBusBridge.js';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { buildAlertingEnvelope } from './alertingEnvelope.js';
import {
  buildChannelPagePayload,
  readDispatchAlertText,
  type DispatchAlertText,
} from '../channels/channelEnvelope.js';
import { queryEligibleMembers, type EligibilitySnapshotItem } from '../eligibility/selector.js';
import { resolvePushTarget, resolveSmsTarget } from '../eligibility/resolvePushTarget.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { queryRoster } from '../roster/repository.js';
import { createSnsClient, readFanOutTopicConfig } from '../fanout/snsClient.js';
import { runWithConcurrencyLimit } from '../fanout/handler.js';
import {
  deriveFanOutKey,
  deriveMessageDeduplicationId,
  type FanOutChannel,
} from '../fanout/idempotencyKey.js';
import { createEscalationSchedule, getSchedulerClient } from './scheduleEscalation.js';
import { requestMutualAid } from './mutualAidPort.js';
import {
  isPredicateMet,
  readDepartmentToneConfig,
  MUTUAL_AID_AFTER_TONE,
  TONE_SEQUENCE_THREE,
} from './toneLadder.js';

const METRIC_NAMESPACE = 'Boxalarm/Alerting';
const CHANNEL_TIER = 'escalation';
const VOICE_ESCALATION_DELAY_SECONDS = 75;
const FAN_OUT_CHANNELS: readonly FanOutChannel[] = ['push', 'sms'];
const MAX_CONCURRENT_TONE_TASKS = 10;
const GUARD_ITEM_INDEX = 0;
const METADATA_ITEM_INDEX = 3;

interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

function isGuardConflict(error: unknown): boolean {
  return (
    asTransactionCancellation(error)?.CancellationReasons?.[GUARD_ITEM_INDEX]?.Code ===
    'ConditionalCheckFailed'
  );
}

function isMetadataAdvanceRejected(error: unknown): boolean {
  const cancellation = asTransactionCancellation(error);
  return (
    cancellation?.CancellationReasons?.[GUARD_ITEM_INDEX]?.Code !== 'ConditionalCheckFailed' &&
    cancellation?.CancellationReasons?.[METADATA_ITEM_INDEX]?.Code === 'ConditionalCheckFailed'
  );
}

export interface ToneEvaluatorPayload {
  readonly deptId: string;
  readonly dispatchId: string;
  readonly toneSequence: number;
}

export type ToneOutcome =
  | 'FIRED'
  | 'SKIPPED_PREDICATE_MET'
  | 'SKIPPED_ALREADY_FIRED'
  | 'SKIPPED_MANUALLY_HALTED'
  | 'SKIPPED_COMPLETED'
  | 'SKIPPED_NOT_FOUND';

function isToneEvaluatorPayload(value: unknown): value is ToneEvaluatorPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deptId === 'string' &&
    candidate.deptId.length > 0 &&
    typeof candidate.dispatchId === 'string' &&
    candidate.dispatchId.length > 0 &&
    typeof candidate.toneSequence === 'number'
  );
}

interface DispatchMetadata extends DispatchAlertText {
  readonly toneLadderStatus: string;
}

async function publishToneChannel(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
  memberId: string,
  channel: FanOutChannel,
  toneSequence: number,
): Promise<void> {
  const { sk, idempotencyKey } = deriveFanOutKey({ dispatchId, toneSequence, memberId, channel });
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk,
          sk,
          entityType: 'DELIVERY_RECEIPT',
          dispatchId,
          memberId,
          deptId,
          channel,
          channelTier: CHANNEL_TIER,
          toneSequence,
          idempotencyKey,
          gsi1pk: `MEMBER#${memberId}`,
          gsi1sk: `RECEIPT#${Math.floor(Date.now() / 1000)}#${dispatchId}`,
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      logInfo('alerting.toneLadder.duplicateReceipt', {
        deptId,
        dispatchId,
        memberId,
        channel,
        toneSequence,
      });
      return;
    }
    logError('alerting.toneLadder.receiptWriteFailed', error, {
      deptId,
      dispatchId,
      memberId,
      channel,
    });
    throw error;
  }

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(
        buildAlertingEnvelope(
          'alerting.dispatch.normalized',
          dispatchId,
          buildChannelPagePayload({
            deptId,
            dispatchId,
            memberId,
            channel,
            channelTier: CHANNEL_TIER,
            toneSequence,
            dispatch,
          }),
        ),
      ),
      MessageGroupId: dispatchId,
      MessageDeduplicationId: deriveMessageDeduplicationId({
        dispatchId,
        toneSequence,
        memberId,
        channel,
      }),
      MessageAttributes: {
        channel: { DataType: 'String', StringValue: channel },
        channelTier: { DataType: 'String', StringValue: CHANNEL_TIER },
        toneSequence: { DataType: 'Number', StringValue: String(toneSequence) },
      },
    }),
  );
}

async function fireToneForMember(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  scheduler: Parameters<typeof createEscalationSchedule>[0],
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
  toneSequence: number,
  member: EligibilitySnapshotItem,
): Promise<void> {
  for (const channel of FAN_OUT_CHANNELS) {
    if (channel === 'push' && resolvePushTarget(member.contactChannels).skipped) {
      continue;
    }
    if (channel === 'sms' && resolveSmsTarget(member.contactChannels).skipped) {
      continue;
    }
    await publishToneChannel(
      ddb,
      sns,
      tableName,
      topicArn,
      deptId,
      dispatchId,
      dispatch,
      member.memberId,
      channel,
      toneSequence,
    );
  }
  try {
    await createEscalationSchedule(
      scheduler,
      {
        deptId,
        dispatchId,
        memberId: member.memberId,
        toneSequence,
        delaySeconds: VOICE_ESCALATION_DELAY_SECONDS,
      },
      ddb,
      tableName,
    );
  } catch (error) {
    logError('alerting.toneLadder.voiceScheduleFailed', error, {
      deptId,
      dispatchId,
      memberId: member.memberId,
      toneSequence,
    });
  }
}

async function fireTone(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  scheduler: Parameters<typeof createEscalationSchedule>[0],
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
  toneSequence: number,
  members: readonly EligibilitySnapshotItem[],
): Promise<void> {
  const results = await runWithConcurrencyLimit(members, MAX_CONCURRENT_TONE_TASKS, (member) =>
    fireToneForMember(
      ddb,
      sns,
      scheduler,
      tableName,
      topicArn,
      deptId,
      dispatchId,
      dispatch,
      toneSequence,
      member,
    ),
  );
  const failures: PromiseRejectedResult[] = [];
  results.forEach((result, index) => {
    if (result.status !== 'rejected') {
      return;
    }
    failures.push(result);
    logError('alerting.toneLadder.memberFireFailed', result.reason, {
      deptId,
      dispatchId,
      memberId: members[index]?.memberId,
      toneSequence,
    });
  });
  if (failures.length > 0) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneFireFailed');
    throw failures[0]!.reason;
  }
}

type ToneCommitResult = 'committed' | 'already_exists';

/**
 * Commits the singleton fire-guard `TONE#{toneSequence}` (and optional METADATA
 * advance) only after paging has succeeded — or when the evaluator is skipping
 * because the responder predicate is already met. Writing the guard before
 * `fireTone` made Scheduler retries return SKIPPED_ALREADY_FIRED and silently
 * suppressed unpublished members / tones 2 and 3.
 *
 * METADATA only advances when `currentToneSequence` is still behind this tone
 * and the ladder is not COMPLETED / HALTED_MANUAL. A rejected advance still
 * writes the fire-guard so retries stop; any other transaction cancel throws
 * so Scheduler retries.
 */
async function writeToneGuardItems(
  ddb: DynamoDBDocumentClient,
  transactItems: NonNullable<TransactWriteCommandInput['TransactItems']>,
  correlationId: string,
): Promise<ToneCommitResult> {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: transactItems,
      }),
    );
    return 'committed';
  } catch (error) {
    if (isGuardConflict(error)) {
      return 'already_exists';
    }
    logError('alerting.toneLadder.guardWriteFailed', error, {
      correlationId,
      cancellationReasons: asTransactionCancellation(error)?.CancellationReasons?.map(
        (r) => r.Code,
      ),
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneEvaluationFailed');
    throw error;
  }
}

async function commitToneEvaluation(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  toneSequence: number,
  evaluatedAt: number,
  outcome: ToneOutcome,
  eligibleMemberCount: number,
  predicateSnapshot: {
    readonly minResponders: number;
    readonly requiredQuals: readonly string[];
    readonly respondingCount: number;
  },
  options: { readonly advanceMetadata: boolean },
): Promise<ToneCommitResult> {
  const correlationId = `${dispatchId}#${toneSequence}`;
  const guardAndAudit: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk,
          sk: `TONE#${toneSequence}`,
          entityType: 'TONE_EVENT_GUARD',
          dispatchId,
          deptId,
          toneSequence,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: {
          pk,
          sk: `TONE#${toneSequence}#${evaluatedAt}`,
          entityType: 'TONE_EVENT',
          dispatchId,
          deptId,
          toneSequence,
          evaluatedAt,
          outcome,
          eligibleMemberCount,
        },
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: buildBridgeOutboxRecord(deptId, 'alerting.tone.escalated', correlationId, {
          dispatchId,
          toneSequence,
          firedAt: evaluatedAt,
          outcome,
          predicateSnapshot,
          eligibleMemberCount,
        }),
      },
    },
  ];
  if (!options.advanceMetadata) {
    return writeToneGuardItems(ddb, guardAndAudit, correlationId);
  }
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...guardAndAudit,
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk: 'METADATA' },
              UpdateExpression: 'SET currentToneSequence = :tone, toneLadderStatus = :status',
              ConditionExpression:
                'currentToneSequence < :tone AND toneLadderStatus <> :completed AND toneLadderStatus <> :halted',
              ExpressionAttributeValues: {
                ':tone': toneSequence,
                ':status': toneSequence >= MUTUAL_AID_AFTER_TONE ? 'COMPLETED' : 'ACTIVE',
                ':completed': 'COMPLETED',
                ':halted': 'HALTED_MANUAL',
              },
            },
          },
        ],
      }),
    );
    return 'committed';
  } catch (error) {
    if (isGuardConflict(error)) {
      return 'already_exists';
    }
    if (isMetadataAdvanceRejected(error)) {
      logInfo('alerting.toneLadder.metadataAdvanceSkipped', { correlationId, toneSequence });
      return writeToneGuardItems(ddb, guardAndAudit, correlationId);
    }
    logError('alerting.toneLadder.guardWriteFailed', error, {
      correlationId,
      cancellationReasons: asTransactionCancellation(error)?.CancellationReasons?.map(
        (r) => r.Code,
      ),
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneEvaluationFailed');
    throw error;
  }
}

export const handler = async (payload: unknown): Promise<{ outcome: ToneOutcome }> => {
  if (!isToneEvaluatorPayload(payload)) {
    const error = new Error('tone evaluator payload failed shape validation');
    logError('alerting.toneLadder.malformedPayload', error, {});
    throw error;
  }
  const { dispatchId, toneSequence } = payload;
  const deptId = toVerifiedDeptId({ deptId: payload.deptId });
  const correlationId = `${dispatchId}#${toneSequence}`;
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const sns = createSnsClient(process.env);
  const { topicArn } = readFanOutTopicConfig(process.env);
  const scheduler = getSchedulerClient();
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);

  const metadataResult = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' } }),
  );
  const metadataItem = metadataResult.Item;
  if (!metadataItem) {
    logInfo('alerting.toneLadder.dispatchNotFound', { correlationId });
    return { outcome: 'SKIPPED_NOT_FOUND' };
  }
  const dispatch: DispatchMetadata = {
    ...readDispatchAlertText(metadataItem),
    toneLadderStatus:
      typeof metadataItem.toneLadderStatus === 'string' ? metadataItem.toneLadderStatus : 'ACTIVE',
  };

  if (dispatch.toneLadderStatus === 'HALTED_MANUAL') {
    logInfo('alerting.toneLadder.skippedHalted', { correlationId });
    return { outcome: 'SKIPPED_MANUALLY_HALTED' };
  }
  if (dispatch.toneLadderStatus === 'COMPLETED') {
    logInfo('alerting.toneLadder.skippedCompleted', { correlationId });
    return { outcome: 'SKIPPED_COMPLETED' };
  }

  const existingGuard = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk: `TONE#${toneSequence}` },
      ConsistentRead: true,
    }),
  );
  if (existingGuard.Item) {
    logInfo('alerting.toneLadder.alreadyEvaluated', { correlationId });
    return { outcome: 'SKIPPED_ALREADY_FIRED' };
  }

  const roster = await queryRoster(ddb, tableName, deptId, dispatchId);
  const toneConfig = await readDepartmentToneConfig(ddb, tableName, deptId);
  const predicateMet = isPredicateMet(roster, toneConfig);
  const outcome: ToneOutcome = predicateMet ? 'SKIPPED_PREDICATE_MET' : 'FIRED';
  const evaluatedAt = Math.floor(Date.now() / 1000);
  const respondingCount = roster.filter(
    (entry) => entry.ackStatus === 'RESPONDING' || entry.ackStatus === 'DIRECT_TO_SCENE',
  ).length;
  const predicateSnapshot = {
    minResponders: toneConfig.minResponders,
    requiredQuals: toneConfig.requiredQuals,
    respondingCount,
  };

  if (predicateMet) {
    const skipCommit = await commitToneEvaluation(
      ddb,
      tableName,
      pk,
      deptId,
      dispatchId,
      toneSequence,
      evaluatedAt,
      outcome,
      roster.length,
      predicateSnapshot,
      { advanceMetadata: false },
    );
    if (skipCommit === 'already_exists') {
      logInfo('alerting.toneLadder.alreadyEvaluated', { correlationId });
      return { outcome: 'SKIPPED_ALREADY_FIRED' };
    }
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneSkippedPredicateMet');
    logInfo('alerting.toneLadder.predicateMet', { correlationId });
    return { outcome };
  }

  const eligibleMembers = await queryEligibleMembers(ddb, tableName, deptId);
  await fireTone(
    ddb,
    sns,
    scheduler,
    tableName,
    topicArn,
    deptId,
    dispatchId,
    dispatch,
    toneSequence,
    eligibleMembers,
  );

  const fireCommit = await commitToneEvaluation(
    ddb,
    tableName,
    pk,
    deptId,
    dispatchId,
    toneSequence,
    evaluatedAt,
    outcome,
    eligibleMembers.length,
    predicateSnapshot,
    { advanceMetadata: true },
  );
  if (fireCommit === 'already_exists') {
    logInfo('alerting.toneLadder.alreadyEvaluated', { correlationId });
    return { outcome: 'SKIPPED_ALREADY_FIRED' };
  }

  if (toneSequence === TONE_SEQUENCE_THREE) {
    try {
      await requestMutualAid({
        ddb,
        sns,
        tableName,
        topicArn,
        deptId,
        dispatchId,
        dispatch,
        reason: 'TONE_3_PREDICATE_UNMET',
      });
    } catch (error) {
      logError('alerting.toneLadder.mutualAidFailed', error, { correlationId });
    }
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'ToneFired');
  logInfo('alerting.toneLadder.fired', {
    correlationId,
    toneSequence,
    eligibleMemberCount: eligibleMembers.length,
  });
  return { outcome };
};
