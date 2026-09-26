import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf, emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from './dynamoClient.js';
import type { AvailabilityState } from './selector.js';

const METRIC_NAMESPACE = 'Boxalarm/alerting-eligibility';
const DEDUP_TTL_SECONDS = 48 * 60 * 60;
const CONSUMER_NAME = 'eligibility-consumer';

interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

interface AvailabilityChangedEnvelope {
  readonly eventId: string;
  readonly eventTime: number;
  readonly deptId: string;
  readonly memberId: string;
  readonly availabilityState: AvailabilityState;
}

/**
 * The availability-snapshot queue is an EventBridge rule target with no inputPath, so each SQS
 * body is the whole EventBridge event and the outbox envelope sits under `detail` — the same
 * contract eligibilityChangedConsumer parses.
 */
function parseEnvelope(body: string): AvailabilityChangedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  if (typeof parsed.detail !== 'object' || parsed.detail === null) {
    throw new Error('personnel.availability.changed message is missing detail');
  }
  const raw = parsed.detail as Record<string, unknown>;
  const eventId = raw.eventId;
  const eventTimeRaw = raw.eventTime;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const deptId = payload?.deptId;
  const memberId = payload?.memberId;
  const availabilityState = payload?.availabilityState;
  const eventTime = typeof eventTimeRaw === 'string' ? Date.parse(eventTimeRaw) : NaN;
  if (
    typeof eventId !== 'string' ||
    !Number.isFinite(eventTime) ||
    typeof deptId !== 'string' ||
    typeof memberId !== 'string' ||
    (availabilityState !== 'AVAILABLE' &&
      availabilityState !== 'MARKED_OFF' &&
      availabilityState !== 'LOA')
  ) {
    throw new Error('personnel.availability.changed event failed shape validation');
  }
  return { eventId, eventTime, deptId, memberId, availabilityState };
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

export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: AvailabilityChangedEnvelope;
    try {
      envelope = parseEnvelope(record.body);
    } catch (error) {
      logError('eligibility.malformed_event', error, record.messageId);
      throw error;
    }

    const { eventId, eventTime, memberId, availabilityState } = envelope;
    const deptId = toVerifiedDeptId({ deptId: envelope.deptId });

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'DEDUP', CONSUMER_NAME, memberId),
                  sk: `EVT#${eventId}`,
                  entityType: 'EVENT_DEDUP',
                  ttl: Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS,
                },
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'), sk: `MEMBER#${memberId}` },
                UpdateExpression: 'SET availabilityState = :state, snapshotUpdatedAt = :now',
                ConditionExpression:
                  'attribute_exists(pk) AND (attribute_not_exists(snapshotUpdatedAt) OR :now > snapshotUpdatedAt)',
                ExpressionAttributeValues: { ':state': availabilityState, ':now': eventTime },
              },
            },
          ],
        }),
      );
    } catch (error) {
      const cancellation = asTransactionCancellation(error);
      if (cancellation) {
        const reasons = cancellation.CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') {
          emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped');
          continue;
        }
        if (reasons[1]?.Code === 'ConditionalCheckFailed') {
          logError('eligibility.snapshot_update_skipped', error, eventId, {
            cancellationReasons: reasons.map((r) => r.Code),
          });
          emitOutcomeMetric(METRIC_NAMESPACE, 'SnapshotUpdateSkipped');
          continue;
        }
        logError('eligibility.snapshot_update_failed', error, eventId, {
          cancellationReasons: reasons.map((r) => r.Code),
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'SnapshotUpdateFailed');
        throw error;
      }
      logError('eligibility.snapshot_update_failed', error, eventId);
      emitOutcomeMetric(METRIC_NAMESPACE, 'SnapshotUpdateFailed');
      throw error;
    }

    emitOutcomeMetric(METRIC_NAMESPACE, 'SnapshotUpdated');

    const latencyMs = Date.now() - eventTime;
    if (latencyMs < 0) {
      logError(
        'eligibility.snapshot_propagation_future_event_time',
        new Error('clock skew'),
        eventId,
        {
          latencyMs,
        },
      );
    }
    emitEmf(METRIC_NAMESPACE, 'SnapshotPropagationLatencyMs', Math.max(latencyMs, 0), [[]]);
  }
};
