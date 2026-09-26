import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from './dynamoClient.js';

const LATENCY_METRIC_NAMESPACE = 'Boxalarm/AlertingEligibility';

interface MemberUpdatedPayload {
  readonly deptId: string;
  readonly memberId: string;
  readonly active?: boolean;
  readonly quals?: readonly string[];
  readonly roles?: readonly string[];
  readonly contactChannels?: readonly unknown[];
  readonly availabilityState?: string;
}

interface MemberUpdatedEnvelope {
  readonly eventTime: string;
  readonly eventType: string;
  readonly payload: MemberUpdatedPayload;
}

function emitSnapshotMetric(outcome: 'Updated' | 'Stale' | 'Failed'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/push-token',
            Dimensions: [[]],
            Metrics: [{ Name: `EligibilitySnapshot${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      [`EligibilitySnapshot${outcome}`]: 1,
    }),
  );
}

/**
 * The queue is fed by an EventBridge rule target with no inputPath, so each SQS body is the
 * whole EventBridge event and the outbox envelope sits under `detail` — the same contract
 * eligibilityChangedConsumer parses.
 */
function parseEnvelope(body: string): MemberUpdatedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const detail = parsed.detail;
  if (typeof detail !== 'object' || detail === null) {
    throw new Error('personnel.member.updated message is missing detail');
  }
  const envelope = detail as Partial<MemberUpdatedEnvelope>;
  const payload = envelope.payload;
  if (!payload || typeof payload.memberId !== 'string' || payload.memberId.length === 0) {
    throw new Error('personnel.member.updated payload is missing memberId');
  }
  if (typeof payload.deptId !== 'string' || payload.deptId.length === 0) {
    throw new Error('personnel.member.updated payload is missing deptId');
  }
  if (typeof envelope.eventTime !== 'string' || envelope.eventTime.length === 0) {
    throw new Error('personnel.member.updated envelope is missing eventTime');
  }
  return { eventTime: envelope.eventTime, eventType: envelope.eventType ?? '', payload };
}

function buildMergeExpression(payload: MemberUpdatedPayload, snapshotUpdatedAt: number) {
  const setClauses = [
    'entityType = :entityType',
    'memberId = :memberId',
    'snapshotUpdatedAt = :snapshotUpdatedAt',
  ];
  const values: Record<string, unknown> = {
    ':entityType': 'MEMBER_ELIGIBILITY_SNAPSHOT',
    ':memberId': payload.memberId,
    ':snapshotUpdatedAt': snapshotUpdatedAt,
  };

  if (payload.active !== undefined) {
    setClauses.push('active = :active');
    values[':active'] = payload.active;
  }
  if (payload.quals !== undefined) {
    setClauses.push('quals = :quals');
    values[':quals'] = payload.quals;
  }
  if (payload.roles !== undefined) {
    setClauses.push('roles = :roles');
    values[':roles'] = payload.roles;
  }
  if (payload.contactChannels !== undefined) {
    setClauses.push('contactChannels = :contactChannels');
    values[':contactChannels'] = payload.contactChannels;
  }
  if (payload.availabilityState !== undefined) {
    setClauses.push('availabilityState = :availabilityState');
    values[':availabilityState'] = payload.availabilityState;
  }

  return { UpdateExpression: `SET ${setClauses.join(', ')}`, ExpressionAttributeValues: values };
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const client = createDynamoClient(process.env);
  const tableName = readAlertingConfig(process.env).tableName;

  for (const record of event.Records) {
    const envelope = parseEnvelope(record.body);
    const { payload } = envelope;
    const deptId = toVerifiedDeptId({ deptId: payload.deptId });
    const pk = buildDeptScopedPk(deptId, 'ELIGIBILITY');
    const snapshotUpdatedAt = Date.parse(envelope.eventTime);
    const { UpdateExpression, ExpressionAttributeValues } = buildMergeExpression(
      payload,
      snapshotUpdatedAt,
    );

    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk, sk: `MEMBER#${payload.memberId}` },
          UpdateExpression,
          ConditionExpression:
            'attribute_not_exists(snapshotUpdatedAt) OR snapshotUpdatedAt < :snapshotUpdatedAt',
          ExpressionAttributeValues,
        }),
      );
      emitSnapshotMetric('Updated');

      const latencyMs = Date.now() - snapshotUpdatedAt;
      if (latencyMs < 0) {
        console.warn(
          JSON.stringify({
            event: 'alerting.eligibility.snapshot_propagation.future_event_time',
            service: 'alerting-service',
            correlationId: payload.memberId,
            memberId: payload.memberId,
            latencyMs,
          }),
        );
      }
      emitEmf(LATENCY_METRIC_NAMESPACE, 'SnapshotPropagationLatencyMs', Math.max(latencyMs, 0), [
        [],
      ]);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        console.log(
          JSON.stringify({
            event: 'alerting.eligibility.snapshot.stale_discarded',
            service: 'alerting-service',
            correlationId: payload.memberId,
            memberId: payload.memberId,
          }),
        );
        emitSnapshotMetric('Stale');
        continue;
      }
      console.error(
        JSON.stringify({
          event: 'alerting.eligibility.snapshot.update.failed',
          service: 'alerting-service',
          correlationId: payload.memberId,
          memberId: payload.memberId,
          reason: error instanceof Error ? error.constructor.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      emitSnapshotMetric('Failed');
      throw error;
    }
  }

  return { batchItemFailures: [] };
};
