import type {
  Handler,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocumentClient, getTableName } from './repository.js';
import { putDispatchAlertCopy } from './dispatchProjection.js';

const METRIC_NAMESPACE = 'Boxalarm/incident-dispatch-alert-copy';

interface DispatchAlertReceivedEnvelope {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly incidentType: string;
  readonly address: string;
  readonly crossStreets: string;
  readonly narrative: string;
  readonly dispatchedAt: number;
}

function parseEnvelope(body: string): DispatchAlertReceivedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const detail = parsed.detail as { payload?: Record<string, unknown> } | undefined;
  const payload = detail?.payload;
  if (
    !payload ||
    typeof payload.deptId !== 'string' ||
    typeof payload.dispatchId !== 'string' ||
    typeof payload.incidentType !== 'string' ||
    typeof payload.address !== 'string' ||
    typeof payload.narrative !== 'string' ||
    typeof payload.dispatchedAt !== 'number'
  ) {
    throw new Error('dispatch.alert.received payload failed shape validation');
  }
  return {
    deptId: toVerifiedDeptId({ deptId: payload.deptId }),
    dispatchId: payload.dispatchId,
    incidentType: payload.incidentType,
    address: payload.address,
    crossStreets: typeof payload.crossStreets === 'string' ? payload.crossStreets : '',
    narrative: payload.narrative,
    dispatchedAt: payload.dispatchedAt,
  };
}

function logError(event: string, error: unknown, context: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      service: 'incident-service',
      ...context,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
    }),
  );
}

interface DispatchAlertConsumerDeps {
  readonly client?: DynamoDBDocumentClient;
}

async function processRecord(record: SQSRecord, deps: DispatchAlertConsumerDeps): Promise<void> {
  let envelope: DispatchAlertReceivedEnvelope;
  try {
    envelope = parseEnvelope(record.body);
  } catch (error) {
    logError('incident.dispatchAlertCopy.malformed', error, { correlationId: record.messageId });
    throw error;
  }

  const client = deps.client ?? getDocumentClient();
  const tableName = getTableName(process.env);

  try {
    await putDispatchAlertCopy(client, tableName, {
      dispatchId: envelope.dispatchId,
      deptId: envelope.deptId,
      incidentType: envelope.incidentType,
      address: envelope.address,
      crossStreets: envelope.crossStreets,
      narrative: envelope.narrative,
      dispatchedAt: envelope.dispatchedAt,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'DispatchAlertCopyUpdated');
  } catch (error) {
    logError('incident.dispatchAlertCopy.writeFailed', error, {
      correlationId: envelope.dispatchId,
    });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      'DispatchAlertCopyFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }
}

// Partial batch response: a failing record is reported alone (its error was already
// logged inside processRecord) so SQS redelivers only that record instead of the whole
// batch. Requires ReportBatchItemFailures on the event source mapping.
export function createHandler(
  deps: DispatchAlertConsumerDeps = {},
): Handler<SQSEvent, SQSBatchResponse> {
  return async (event) => {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    for (const record of event.Records) {
      try {
        await processRecord(record, deps);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

export const handler = createHandler();
