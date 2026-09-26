import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { parseRosterItem } from '../fanout/fanOut.js';
import { deriveFanOutKey } from '../fanout/idempotencyKey.js';
import { readDispatchAlertText, type DispatchAlertText } from '../channels/channelEnvelope.js';
import { getSnsClient, publishEscalationTriggered, readAlertingTopicConfig } from './snsClient.js';

const METRIC_NAMESPACE = 'Boxalarm/Alerting';
const RECEIPT_ITEM_INDEX = 1;

export interface EscalationSchedulePayload {
  readonly deptId: string;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly toneSequence: number;
  readonly channel: 'voice';
}

export type EscalationOutcome =
  'ESCALATED' | 'SKIPPED_ACKED' | 'SKIPPED_ALREADY_ESCALATED' | 'SKIPPED_NOT_FOUND';

function isEscalationSchedulePayload(value: unknown): value is EscalationSchedulePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deptId === 'string' &&
    candidate.deptId.length > 0 &&
    typeof candidate.dispatchId === 'string' &&
    candidate.dispatchId.length > 0 &&
    typeof candidate.memberId === 'string' &&
    candidate.memberId.length > 0 &&
    typeof candidate.toneSequence === 'number' &&
    candidate.channel === 'voice'
  );
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

export const handler = async (payload: unknown): Promise<{ outcome: EscalationOutcome }> => {
  if (!isEscalationSchedulePayload(payload)) {
    const error = new Error('escalation schedule payload failed shape validation');
    logError('alerting.escalation.malformed_payload', error, { correlationId: 'unknown' });
    throw error;
  }

  const { dispatchId, memberId, toneSequence } = payload;
  const deptId = toVerifiedDeptId({ deptId: payload.deptId });
  const correlationId = `${dispatchId}#${toneSequence}#${memberId}#voice`;
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  const rosterSk = `ROSTER#${memberId}`;

  let roster;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk: rosterSk } }),
    );
    roster = parseRosterItem(result.Item);
  } catch (error) {
    logError('alerting.escalation.read_failed', error, { correlationId });
    throw error;
  }

  if (!roster) {
    logInfo('alerting.escalation.skipped_not_found', { correlationId });
    return { outcome: 'SKIPPED_NOT_FOUND' };
  }

  if (roster.ackStatus !== 'NONE') {
    logInfo('alerting.escalation.skipped_acked', { correlationId, ackStatus: roster.ackStatus });
    emitOutcomeMetric(METRIC_NAMESPACE, 'EscalationSkipped', 'Acked');
    return { outcome: 'SKIPPED_ACKED' };
  }

  // The voice worker speaks incidentType/address, so source them from the dispatch's METADATA
  // item exactly as the tone evaluator does. A missing item still pages (placeholder text,
  // isTest=false): this member has not acked, and a silent skip is the worse failure.
  let dispatch: DispatchAlertText;
  try {
    const metadata = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' } }),
    );
    if (!metadata.Item) {
      logInfo('alerting.escalation.dispatch_metadata_missing', { correlationId });
    }
    dispatch = readDispatchAlertText(metadata.Item ?? {});
  } catch (error) {
    logError('alerting.escalation.read_failed', error, { correlationId });
    throw error;
  }

  const escalatedAt = Math.floor(Date.now() / 1000);
  // Same canonical producer key as fan-out and the tone evaluator (lowercase channel). The voice
  // worker writes its own send guard under RECEIPT#{memberId}#VOICE#{toneSequence}; sharing that
  // key made whichever write landed second lose — the worker duplicate-skipped the call, or this
  // transaction cancelled and never recorded the escalation.
  const { sk: receiptSk, idempotencyKey } = deriveFanOutKey({
    dispatchId,
    toneSequence,
    memberId,
    channel: 'voice',
  });

  // Publish before the DynamoDB write, not after: publishEscalationTriggered carries a
  // deterministic SNS FIFO MessageDeduplicationId (dispatchId#toneSequence#memberId#voice), so a
  // retried publish is safely deduped. Publishing after the conditional write would let a retry
  // land on "already escalated" (from the earlier write succeeding) and skip publishing forever —
  // recording the escalation as delivered while the voice call never actually fires. See
  // boxalarm-docs#11 for the prior SMS-never-sends incident this mirrors.
  const { topicArn } = readAlertingTopicConfig(process.env);
  try {
    await publishEscalationTriggered(getSnsClient(), topicArn, {
      deptId,
      dispatchId,
      memberId,
      toneSequence,
      dispatch,
    });
  } catch (error) {
    logError('alerting.escalation.publish_failed', error, { correlationId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'EscalationFailed', 'SnsUnavailable');
    throw error;
  }

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: `ESCALATION#${memberId}#${toneSequence}#${escalatedAt}`,
                entityType: 'ESCALATION_EVENT',
                memberId,
                fromChannel: 'primary',
                toChannel: 'VOICE',
                toneSequence,
                escalatedAt,
                reason: 'NO_ACK_TIMEOUT',
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: receiptSk,
                entityType: 'DELIVERY_RECEIPT',
                dispatchId,
                memberId,
                deptId,
                channel: 'voice',
                channelTier: 'escalation',
                toneSequence,
                sentAt: escalatedAt,
                idempotencyKey,
              },
              ConditionExpression: 'attribute_not_exists(idempotencyKey)',
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk: rosterSk },
              UpdateExpression: 'SET currentChannelTier = :tier, escalationLevel = :level',
              ExpressionAttributeValues: { ':tier': 'escalation', ':level': 1 },
            },
          },
        ],
      }),
    );
  } catch (error) {
    const cancellation = asTransactionCancellation(error);
    if (cancellation) {
      if (
        cancellation.CancellationReasons?.[RECEIPT_ITEM_INDEX]?.Code === 'ConditionalCheckFailed'
      ) {
        logInfo('alerting.escalation.skipped_already_escalated', { correlationId });
        return { outcome: 'SKIPPED_ALREADY_ESCALATED' };
      }
      logError('alerting.escalation.write_failed', error, {
        correlationId,
        cancellationReasons: cancellation.CancellationReasons?.map((r) => r.Code),
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'EscalationFailed', 'DynamoDbUnavailable');
      throw error;
    }
    logError('alerting.escalation.write_failed', error, { correlationId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'EscalationFailed', 'DynamoDbUnavailable');
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'EscalationTriggered');
  logInfo('alerting.escalation.triggered', { correlationId });
  return { outcome: 'ESCALATED' };
};
