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
import { putRosterCopyEntryIfNewer } from './dispatchProjection.js';

const METRIC_NAMESPACE = 'Boxalarm/incident-dispatch-roster-copy';

interface ResponseConfirmedEnvelope {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly status: string;
  readonly ackAt: number;
}

function parseEnvelope(body: string): ResponseConfirmedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const detail = parsed.detail as { payload?: Record<string, unknown> } | undefined;
  const payload = detail?.payload;
  if (
    !payload ||
    typeof payload.deptId !== 'string' ||
    typeof payload.dispatchId !== 'string' ||
    typeof payload.memberId !== 'string' ||
    typeof payload.status !== 'string' ||
    typeof payload.ackAt !== 'number'
  ) {
    throw new Error('alerting.response.confirmed payload failed shape validation');
  }
  return {
    deptId: toVerifiedDeptId({ deptId: payload.deptId }),
    dispatchId: payload.dispatchId,
    memberId: payload.memberId,
    status: payload.status,
    ackAt: payload.ackAt,
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

interface DispatchResponseConsumerDeps {
  readonly client?: DynamoDBDocumentClient;
}

async function processRecord(record: SQSRecord, deps: DispatchResponseConsumerDeps): Promise<void> {
  let envelope: ResponseConfirmedEnvelope;
  try {
    envelope = parseEnvelope(record.body);
  } catch (error) {
    logError('incident.dispatchRosterCopy.malformed', error, { correlationId: record.messageId });
    throw error;
  }

  const client = deps.client ?? getDocumentClient();
  const tableName = getTableName(process.env);

  try {
    const outcome = await putRosterCopyEntryIfNewer(
      client,
      tableName,
      envelope.deptId,
      envelope.dispatchId,
      { memberId: envelope.memberId, status: envelope.status, ackAt: envelope.ackAt },
    );
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      outcome === 'updated' ? 'DispatchRosterCopyUpdated' : 'DispatchRosterCopySkippedStale',
    );
  } catch (error) {
    logError('incident.dispatchRosterCopy.writeFailed', error, {
      correlationId: envelope.dispatchId,
      memberId: envelope.memberId,
    });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      'DispatchRosterCopyFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }
}

// Partial batch response: a failing record is reported alone (its error was already
// logged inside processRecord) so SQS redelivers only that record instead of the whole
// batch. Requires ReportBatchItemFailures on the event source mapping.
export function createHandler(
  deps: DispatchResponseConsumerDeps = {},
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
