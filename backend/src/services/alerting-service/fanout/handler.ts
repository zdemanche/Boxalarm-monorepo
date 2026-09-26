import { randomUUID } from 'node:crypto';
import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf, emitOutcomeMetric } from '@boxalarm/metrics';
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { getMemberEligibility, queryEligibleMembers } from '../eligibility/selector.js';
import { resolvePushTarget, resolveSmsTarget } from '../eligibility/resolvePushTarget.js';
import { buildChannelPagePayload } from '../channels/channelEnvelope.js';
import { getSchedulerClient } from '../escalation/scheduleEscalation.js';
import { scheduleRealtimeFanOutEscalation } from './fanOut.js';
import {
  SELF_TEST_METRIC_NAMESPACE,
  upsertSelfTestRun,
  type SelfTestChannelResult,
} from '../selfTest/selfTestRunRepository.js';
import {
  deriveFanOutKey,
  deriveMessageDeduplicationId,
  type FanOutChannel,
  type FanOutKeyInput,
} from './idempotencyKey.js';
import { createSnsClient, readFanOutTopicConfig } from './snsClient.js';

const METRIC_NAMESPACE = 'Boxalarm/alerting-fan-out';
const TONE_SEQUENCE = 1;
const FAN_OUT_CHANNELS: readonly FanOutChannel[] = ['push', 'sms'];
const CHANNEL_TIER = 'primary';
const MAX_CONCURRENT_FANOUT_TASKS = 10;
const TEST_AUDIT_TTL_SECONDS = 60 * 60 * 24 * 365;

interface DispatchAlertRecord {
  readonly dispatchId: string;
  readonly deptId: VerifiedDeptId;
  readonly incidentType: string | undefined;
  readonly address: string | undefined;
  readonly crossStreets: string | undefined;
  readonly narrative: string | undefined;
  readonly mapLink: string | undefined;
  readonly isTest: boolean;
  readonly sourceSystem: string | undefined;
  readonly targetMemberId: string | undefined;
  readonly selfTestId: string | undefined;
  readonly channelsTested: readonly string[] | undefined;
}

interface FanOutTask {
  readonly memberId: string;
  readonly channel: FanOutChannel;
}

interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

function logError(
  event: string,
  error: unknown,
  correlationId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'alerting-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

function logInfo(event: string, correlationId: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event,
      service: 'alerting-service',
      correlationId,
      ...extra,
    }),
  );
}

export async function runWithConcurrencyLimit<T>(
  tasks: readonly T[],
  limit: number,
  fn: (task: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = [];
  for (let offset = 0; offset < tasks.length; offset += limit) {
    const chunk = tasks.slice(offset, offset + limit);
    results.push(...(await Promise.allSettled(chunk.map(fn))));
  }
  return results;
}

function parseDispatchAlertRecord(record: DynamoDBRecord): DispatchAlertRecord | undefined {
  if (record.eventName !== 'INSERT') {
    return undefined;
  }
  const image = record.dynamodb?.NewImage;
  if (!image) {
    return undefined;
  }
  const item = unmarshall(image as Record<string, never>) as Record<string, unknown>;
  if (item.entityType !== 'DISPATCH_ALERT') {
    return undefined;
  }
  const dispatchId = item.dispatchId;
  const deptIdRaw = item.deptId;
  if (typeof dispatchId !== 'string' || typeof deptIdRaw !== 'string') {
    throw new Error('DISPATCH_ALERT stream record failed shape validation');
  }
  return {
    dispatchId,
    deptId: toVerifiedDeptId({ deptId: deptIdRaw }),
    incidentType: typeof item.incidentType === 'string' ? item.incidentType : undefined,
    address: typeof item.address === 'string' ? item.address : undefined,
    crossStreets: typeof item.crossStreets === 'string' ? item.crossStreets : undefined,
    narrative: typeof item.narrative === 'string' ? item.narrative : undefined,
    mapLink: typeof item.mapLink === 'string' ? item.mapLink : undefined,
    isTest: item.isTest === true,
    sourceSystem: typeof item.sourceSystem === 'string' ? item.sourceSystem : undefined,
    targetMemberId: typeof item.targetMemberId === 'string' ? item.targetMemberId : undefined,
    selfTestId: typeof item.selfTestId === 'string' ? item.selfTestId : undefined,
    channelsTested: Array.isArray(item.channelsTested)
      ? (item.channelsTested as string[])
      : undefined,
  };
}

function buildDispatchNormalizedEnvelope(
  dispatch: DispatchAlertRecord,
  task: FanOutTask,
): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    eventTime: new Date().toISOString(),
    eventType: 'alerting.dispatch.normalized',
    source: 'alert-fanout-service',
    correlationId: dispatch.dispatchId,
    schemaVersion: '1.0',
    payload: buildChannelPagePayload({
      deptId: dispatch.deptId,
      dispatchId: dispatch.dispatchId,
      memberId: task.memberId,
      channel: task.channel,
      channelTier: CHANNEL_TIER,
      toneSequence: TONE_SEQUENCE,
      dispatch,
    }),
  };
}

async function sendOne(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  dispatch: DispatchAlertRecord,
  task: FanOutTask,
): Promise<void> {
  const keyInput: FanOutKeyInput = {
    dispatchId: dispatch.dispatchId,
    toneSequence: TONE_SEQUENCE,
    memberId: task.memberId,
    channel: task.channel,
  };
  const { sk, idempotencyKey } = deriveFanOutKey(keyInput);

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId),
                sk,
                entityType: 'DELIVERY_RECEIPT',
                dispatchId: dispatch.dispatchId,
                memberId: task.memberId,
                deptId: dispatch.deptId,
                channel: task.channel,
                channelTier: CHANNEL_TIER,
                toneSequence: TONE_SEQUENCE,
                isTest: dispatch.isTest,
                idempotencyKey,
                ...(dispatch.isTest
                  ? { ttl: Math.floor(Date.now() / 1000) + TEST_AUDIT_TTL_SECONDS }
                  : {
                      gsi1pk: `MEMBER#${task.memberId}`,
                      gsi1sk: `RECEIPT#${Math.floor(Date.now() / 1000)}#${dispatch.dispatchId}`,
                    }),
              },
              ConditionExpression: 'attribute_not_exists(idempotencyKey)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    const cancellation = asTransactionCancellation(error);
    if (cancellation?.CancellationReasons?.[0]?.Code !== 'ConditionalCheckFailed') {
      logError('fanout.receipt_write_failed', error, dispatch.dispatchId, {
        memberId: task.memberId,
        channel: task.channel,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', 'ReceiptWriteFailed');
      throw error;
    }
    const existing = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId), sk },
      }),
    );
    if (existing.Item?.sentAt) {
      logInfo('fanout.receipt.duplicate_skipped', dispatch.dispatchId, {
        memberId: task.memberId,
        channel: task.channel,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped');
      return;
    }
  }

  try {
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(buildDispatchNormalizedEnvelope(dispatch, task)),
        MessageGroupId: dispatch.dispatchId,
        MessageDeduplicationId: deriveMessageDeduplicationId(keyInput),
        MessageAttributes: {
          channel: { DataType: 'String', StringValue: task.channel },
          channelTier: { DataType: 'String', StringValue: CHANNEL_TIER },
          toneSequence: { DataType: 'Number', StringValue: String(TONE_SEQUENCE) },
          isTest: { DataType: 'String', StringValue: String(dispatch.isTest) },
        },
      }),
    );
  } catch (error) {
    logError('fanout.publish_failed', error, dispatch.dispatchId, {
      memberId: task.memberId,
      channel: task.channel,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', 'SnsUnavailable');
    await ddb
      .send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId), sk },
          UpdateExpression: 'SET failureReason = :reason',
          ExpressionAttributeValues: {
            ':reason': error instanceof Error ? error.constructor.name : 'UnknownError',
          },
        }),
      )
      .catch((updateError) => {
        logError('fanout.receipt_failure_annotation_failed', updateError, dispatch.dispatchId, {
          memberId: task.memberId,
          channel: task.channel,
        });
      });
    throw error;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId), sk },
      UpdateExpression: 'SET sentAt = :sentAt REMOVE failureReason',
      ExpressionAttributeValues: { ':sentAt': Math.floor(Date.now() / 1000) },
    }),
  );

  emitOutcomeMetric(METRIC_NAMESPACE, 'PublishAccepted');
}

async function fanOutOneDispatch(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  scheduler: SchedulerClient,
  tableName: string,
  topicArn: string,
  dispatch: DispatchAlertRecord,
): Promise<void> {
  const fanOutStartedMs = Date.now();

  try {
    const eligibleMembers = await queryEligibleMembers(ddb, tableName, dispatch.deptId);

    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId),
          sk: 'METADATA',
        },
        UpdateExpression: 'SET fanOutStartedAt = :startedAt, eligibleMemberCount = :count',
        ExpressionAttributeValues: {
          ':startedAt': Math.floor(fanOutStartedMs / 1000),
          ':count': eligibleMembers.length,
        },
      }),
    );

    const tasks: FanOutTask[] = [];
    for (const member of eligibleMembers) {
      for (const channel of FAN_OUT_CHANNELS) {
        if (channel === 'push') {
          const pushTarget = resolvePushTarget(member.contactChannels);
          if (pushTarget.skipped) {
            logInfo('fanout.push.skipped', dispatch.dispatchId, {
              memberId: member.memberId,
              reason: pushTarget.reason,
            });
            emitOutcomeMetric(METRIC_NAMESPACE, 'PushSkipped');
            continue;
          }
        }
        tasks.push({ memberId: member.memberId, channel });
      }
    }

    if (tasks.length === 0) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'EmptyRoster');
      return;
    }

    const results = await runWithConcurrencyLimit(tasks, MAX_CONCURRENT_FANOUT_TASKS, (task) =>
      sendOne(ddb, sns, tableName, topicArn, dispatch, task),
    );

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    let schedulingError: Error | undefined;
    try {
      await scheduleRealtimeFanOutEscalation(
        ddb,
        scheduler,
        tableName,
        dispatch.deptId,
        dispatch.dispatchId,
        eligibleMembers.map((member) => ({ memberId: member.memberId, quals: member.quals })),
      );
    } catch (error) {
      schedulingError = error instanceof Error ? error : new Error(String(error));
      logError('fanout.escalation_schedule_failed', error, dispatch.dispatchId);
      emitOutcomeMetric(METRIC_NAMESPACE, 'EscalationScheduleFailed');
    }

    if (failures.length > 0) {
      throw failures[0]!.reason;
    }
    if (schedulingError) {
      throw schedulingError;
    }
  } finally {
    emitEmf(METRIC_NAMESPACE, 'FanOutLatencyMs', Date.now() - fanOutStartedMs, [[]]);
  }
}

async function fanOutSelfTestDispatch(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  dispatch: DispatchAlertRecord,
): Promise<void> {
  const memberId = dispatch.targetMemberId!;
  const runAt = Math.floor(Date.now() / 1000);
  const testId = dispatch.selfTestId ?? String(runAt);
  const channelsTested = dispatch.channelsTested ?? FAN_OUT_CHANNELS.map((c) => c.toUpperCase());

  const member = await getMemberEligibility(ddb, tableName, dispatch.deptId, memberId);
  if (!member) {
    logInfo('fanout.selfTest.memberNotFound', dispatch.dispatchId, { memberId, testId });
    emitOutcomeMetric(SELF_TEST_METRIC_NAMESPACE, 'SelfTestFailed', 'MemberNotFound');
    await upsertSelfTestRun(ddb, tableName, {
      deptId: dispatch.deptId,
      memberId,
      testId,
      runAt,
      channelsTested,
      channelResults: Object.fromEntries(
        channelsTested.map((channel) => [
          channel,
          { ok: false, ms: 0, reason: 'member not found' },
        ]),
      ),
      overallResult: 'FAIL',
      eligibilityReason: 'member not found',
      completedAtMs: Date.now(),
    });
    return;
  }

  const eligibilityReason = !member.active
    ? 'member is inactive — a real dispatch would not page you'
    : member.availabilityState !== 'AVAILABLE'
      ? `member is ${member.availabilityState} — a real dispatch would not page you`
      : undefined;

  const channelResults: Record<string, SelfTestChannelResult> = {};

  for (const channel of FAN_OUT_CHANNELS) {
    if (channel === 'push') {
      const pushTarget = resolvePushTarget(member.contactChannels);
      if (pushTarget.skipped) {
        channelResults.PUSH = { ok: false, ms: 0, reason: pushTarget.reason };
        emitOutcomeMetric(SELF_TEST_METRIC_NAMESPACE, 'SelfTestChannelFailed', 'PushSkipped');
        continue;
      }
    }
    if (channel === 'sms') {
      const smsTarget = resolveSmsTarget(member.contactChannels);
      if (smsTarget.skipped) {
        channelResults.SMS = { ok: false, ms: 0, reason: smsTarget.reason };
        emitOutcomeMetric(SELF_TEST_METRIC_NAMESPACE, 'SelfTestChannelFailed', 'SmsSkipped');
        continue;
      }
    }
    const startedMs = Date.now();
    try {
      await sendOne(ddb, sns, tableName, topicArn, dispatch, { memberId, channel });
      channelResults[channel.toUpperCase()] = { ok: true, ms: Date.now() - startedMs };
      emitOutcomeMetric(SELF_TEST_METRIC_NAMESPACE, 'SelfTestChannelPassed');
    } catch (error) {
      logError('fanout.selfTest.channelFailed', error, dispatch.dispatchId, { memberId, channel });
      channelResults[channel.toUpperCase()] = {
        ok: false,
        ms: Date.now() - startedMs,
        reason: `send failed (${error instanceof Error ? error.constructor.name : 'UnknownError'})`,
      };
      emitOutcomeMetric(SELF_TEST_METRIC_NAMESPACE, 'SelfTestChannelFailed', 'SendFailed');
    }
  }

  const overallResult =
    eligibilityReason === undefined && Object.values(channelResults).every((result) => result.ok)
      ? 'PASS'
      : 'FAIL';
  await upsertSelfTestRun(ddb, tableName, {
    deptId: dispatch.deptId,
    memberId,
    testId,
    runAt,
    channelsTested,
    channelResults,
    overallResult,
    ...(eligibilityReason ? { eligibilityReason } : {}),
    completedAtMs: Date.now(),
  });
  emitOutcomeMetric(
    SELF_TEST_METRIC_NAMESPACE,
    overallResult === 'PASS' ? 'SelfTestPassed' : 'SelfTestFailed',
  );
}

function recordItemIdentifier(record: DynamoDBRecord): string {
  return record.dynamodb?.SequenceNumber ?? record.eventID ?? 'unknown';
}

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const { tableName } = readAlertingConfig(process.env);
  const { topicArn } = readFanOutTopicConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const sns = createSnsClient(process.env);
  const scheduler = getSchedulerClient();

  for (const record of event.Records) {
    let dispatch: DispatchAlertRecord | undefined;
    try {
      dispatch = parseDispatchAlertRecord(record);
    } catch (error) {
      logError('fanout.malformed_record', error, record.eventID ?? 'unknown');
      return { batchItemFailures: [{ itemIdentifier: recordItemIdentifier(record) }] };
    }
    if (!dispatch) {
      continue;
    }
    try {
      if (dispatch.targetMemberId) {
        await fanOutSelfTestDispatch(ddb, sns, tableName, topicArn, dispatch);
      } else {
        await fanOutOneDispatch(ddb, sns, scheduler, tableName, topicArn, dispatch);
      }
    } catch (error) {
      logError('fanout.dispatch_failed', error, dispatch.dispatchId);
      return { batchItemFailures: [{ itemIdentifier: recordItemIdentifier(record) }] };
    }
  }

  return { batchItemFailures: [] };
};
