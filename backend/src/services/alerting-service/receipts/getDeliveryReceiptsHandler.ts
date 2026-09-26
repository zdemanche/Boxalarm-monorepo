import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { assertNoDelimiter, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import {
  queryReceiptsForDispatch,
  type DeliveryReceiptRecord,
} from './deliveryReceiptRepository.js';
import { logError } from './logger.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingReceipts';
const SENT_UNCONFIRMED_AFTER_SECONDS = 300;

export type ReceiptStatus = 'FAILED' | 'OPENED' | 'DELIVERED' | 'SENT_UNCONFIRMED' | 'SENT';

export function deriveReceiptStatus(
  record: Pick<DeliveryReceiptRecord, 'sentAt' | 'deliveredAt' | 'openedAt' | 'failureReason'>,
  nowSeconds: number,
): ReceiptStatus {
  // Positive delivery evidence (opened/delivered) always outranks a failureReason: the
  // repository writes each field independently with if_not_exists, and failureReason has
  // no stored timestamp, so a late/out-of-order failure callback must never downgrade a
  // channel attempt that a provider has already confirmed reached the member.
  if (record.openedAt) {
    return 'OPENED';
  }
  if (record.deliveredAt) {
    return 'DELIVERED';
  }
  if (record.failureReason) {
    return 'FAILED';
  }
  if (nowSeconds - record.sentAt > SENT_UNCONFIRMED_AFTER_SECONDS) {
    return 'SENT_UNCONFIRMED';
  }
  return 'SENT';
}

async function listReceipts(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const dispatchId = event.pathParameters?.dispatchId;
  if (!dispatchId || dispatchId.trim().length === 0) {
    return badRequestProblem(traceId, 'dispatchId path parameter is required');
  }
  try {
    assertNoDelimiter(dispatchId, 'dispatchId');
  } catch (error) {
    return badRequestProblem(
      traceId,
      error instanceof Error ? error.message : 'invalid dispatchId',
    );
  }

  try {
    const deptId = toVerifiedDeptId(principal);
    const client = createDynamoClient(process.env);
    const tableName = readAlertingConfig(process.env).tableName;
    const records = await queryReceiptsForDispatch(client, tableName, deptId, dispatchId);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const receipts = records.map((record) => ({
      memberId: record.memberId,
      channel: record.channel,
      toneSequence: record.toneSequence,
      status: deriveReceiptStatus(record, nowSeconds),
      sentAt: record.sentAt,
      deliveredAt: record.deliveredAt ?? null,
      openedAt: record.openedAt ?? null,
      failureReason: record.failureReason ?? null,
    }));

    emitOutcomeMetric(METRIC_NAMESPACE, 'ReceiptsQueried');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receipts }),
    };
  } catch (error) {
    logError({
      event: 'alerting.receipts.query.failed',
      service: 'alerting-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      traceId,
      dispatchId,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'ReceiptsQueryFailed');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(listReceipts, {
  actionType: 'Boxalarm::Action',
  actionId: 'GetDeliveryReceipts',
  resourceType: 'Boxalarm::Dispatch',
  resourceId: (event) => event.pathParameters?.dispatchId ?? '',
});
