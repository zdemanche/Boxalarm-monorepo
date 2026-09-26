import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import type { IncidentEvent } from './authContext.js';
import {
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  readAuthorizerContext,
  resolveTraceId,
} from './authContext.js';
import { isIncidentStatus, type CreateIncidentInput, type IncidentStatus } from './entity.js';
import {
  DuplicateIncidentError,
  getDocumentClient,
  getIncidentRepository,
  getTableName,
} from './repository.js';
import {
  getDispatchAlertCopy,
  queryIncidentResponseUnits,
  queryRosterCopy,
} from './dispatchProjection.js';
import { createSchemaVersionRepository } from './schemaVersion/repository.js';

class ValidationError extends Error {}

class DispatchNotFoundError extends Error {}

// Sentinel `nerisSchemaVersion` pin for a dispatch-linked incident created before any NERIS
// schema version has ever been published as ACTIVE. It is not a real schema-registry version
// and will never resolve via schemaVersionRepository.getSchemaVersion(); the edit/completion
// paths (updateIncident.ts, putExposures.ts) treat that miss as "no pinned schema to honor"
// and fall back to whatever is ACTIVE at edit time, since there is no earlier schema this
// incident could have been authored under.
const UNVALIDATED_SCHEMA_VERSION = 'UNVALIDATED';

// Leaves headroom under DynamoDB's 400 KB item limit for the rest of the INCIDENT item
// (keys, GSI attributes, NERIS metadata fields) so an oversized corePayload fails fast
// with a clear 400 instead of surfacing as an opaque 503 from the DynamoDB write.
const MAX_CORE_PAYLOAD_BYTES = 350_000;

function parseJsonBody(event: IncidentEvent): unknown {
  if (!event.body) {
    throw new ValidationError('request body is required');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`${key} must be a string`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${key} must be a finite number`);
  }
  return value;
}

function parseCreateIncidentInput(body: unknown, createdBy: string): CreateIncidentInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;

  const dispatchNumber = record.dispatchNumber;
  if (typeof dispatchNumber !== 'string' || dispatchNumber.trim().length === 0) {
    throw new ValidationError('dispatchNumber is required and must be a non-empty string');
  }
  if (dispatchNumber.includes('#')) {
    throw new ValidationError("dispatchNumber cannot contain '#'");
  }

  const epochSeconds = record.epochSeconds;
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) {
    throw new ValidationError('epochSeconds is required and must be a finite number');
  }

  const nerisSchemaVersion = record.nerisSchemaVersion;
  if (typeof nerisSchemaVersion !== 'string' || nerisSchemaVersion.trim().length === 0) {
    throw new ValidationError('nerisSchemaVersion is required and must be a non-empty string');
  }

  const corePayload = record.corePayload;
  if (typeof corePayload !== 'object' || corePayload === null || Array.isArray(corePayload)) {
    throw new ValidationError('corePayload is required and must be a JSON object');
  }
  const corePayloadBytes = Buffer.byteLength(JSON.stringify(corePayload), 'utf8');
  if (corePayloadBytes > MAX_CORE_PAYLOAD_BYTES) {
    throw new ValidationError(
      `corePayload must not exceed ${MAX_CORE_PAYLOAD_BYTES} bytes when serialized; received ${corePayloadBytes} bytes`,
    );
  }

  let status: IncidentStatus | undefined;
  if (record.status !== undefined) {
    if (!isIncidentStatus(record.status)) {
      throw new ValidationError(
        'status must be one of DRAFT, VALIDATED, SUBMITTED, ACCEPTED, REJECTED',
      );
    }
    status = record.status;
  }

  const incidentType = optionalString(record, 'incidentType');
  const address = optionalString(record, 'address');
  const latitude = optionalNumber(record, 'latitude');
  const longitude = optionalNumber(record, 'longitude');
  const alarmAt = optionalNumber(record, 'alarmAt');
  const dispatchAt = optionalNumber(record, 'dispatchAt');
  const arrivedAt = optionalNumber(record, 'arrivedAt');
  const clearedAt = optionalNumber(record, 'clearedAt');
  const narrative = optionalString(record, 'narrative');

  return {
    dispatchNumber: dispatchNumber.trim(),
    epochSeconds,
    nerisSchemaVersion: nerisSchemaVersion.trim(),
    corePayload: corePayload as Readonly<Record<string, unknown>>,
    status: status ?? 'DRAFT',
    ...(incidentType !== undefined ? { incidentType } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
    ...(alarmAt !== undefined ? { alarmAt } : {}),
    ...(dispatchAt !== undefined ? { dispatchAt } : {}),
    ...(arrivedAt !== undefined ? { arrivedAt } : {}),
    ...(clearedAt !== undefined ? { clearedAt } : {}),
    ...(narrative !== undefined ? { narrative } : {}),
    createdBy,
  };
}

function readDispatchId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }
  const dispatchId = (body as Record<string, unknown>).dispatchId;
  return typeof dispatchId === 'string' && dispatchId.trim().length > 0 ? dispatchId : undefined;
}

/**
 * E6-S2: builds a pre-populated CreateIncidentInput from the DISPATCH_ALERT_COPY
 * projection this service maintains from `dispatch.alert.received` (see
 * dispatchAlertConsumer.ts) — never a direct read against alerting-service's table.
 */
async function buildInputFromDispatch(
  deptId: Parameters<typeof getDispatchAlertCopy>[2],
  dispatchId: string,
  createdBy: string,
): Promise<CreateIncidentInput> {
  const client = getDocumentClient();
  const tableName = getTableName(process.env);
  // The two lookups are independent, so run them concurrently. The schema lookup's
  // rejection is observed up front only so an early DispatchNotFound exit can't leave it
  // unhandled; on the normal path it is awaited (and rethrown) below.
  const activeSchemaPromise = createSchemaVersionRepository(
    client,
    tableName,
  ).getActiveSchemaVersion();
  activeSchemaPromise.catch(() => undefined);
  const copy = await getDispatchAlertCopy(client, tableName, deptId, dispatchId);
  if (!copy) {
    throw new DispatchNotFoundError(dispatchId);
  }
  const activeSchema = await activeSchemaPromise;

  return {
    incidentId: dispatchId,
    dispatchNumber: dispatchId,
    epochSeconds: copy.dispatchedAt,
    nerisSchemaVersion: activeSchema?.version ?? UNVALIDATED_SCHEMA_VERSION,
    corePayload: {
      incident_type: copy.incidentType,
      address: copy.address,
      cross_streets: copy.crossStreets,
      narrative: copy.narrative,
    },
    incidentType: copy.incidentType,
    address: copy.address,
    narrative: copy.narrative,
    alarmAt: copy.dispatchedAt,
    dispatchAt: copy.dispatchedAt,
    status: 'DRAFT',
    createdBy,
  };
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  let deptId, isAdmin, sub;
  try {
    ({ deptId, isAdmin, sub } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.create.denied',
        correlationId: traceId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    return problemResponse(
      401,
      'Unauthorized',
      'A valid department-scoped authorization context is required.',
      traceId,
    );
  }

  if (!isAdmin) {
    return problemResponse(
      403,
      'Forbidden',
      'Creating an incident record requires an admin or chief role.',
      traceId,
    );
  }

  let input: CreateIncidentInput;
  let dispatchId: string | undefined;
  try {
    const body = parseJsonBody(event);
    dispatchId = readDispatchId(body);
    input = dispatchId
      ? await buildInputFromDispatch(deptId, dispatchId, sub)
      : parseCreateIncidentInput(body, sub);
  } catch (error) {
    if (error instanceof DispatchNotFoundError) {
      return problemResponse(
        404,
        'Not Found',
        `No dispatch alert found for dispatchId "${error.message}".`,
        traceId,
      );
    }
    return problemResponse(
      400,
      'Bad Request',
      error instanceof ValidationError ? error.message : 'invalid request body',
      traceId,
    );
  }

  try {
    const repository = getIncidentRepository(process.env);
    const incident = await repository.createIncident(deptId, input, nowEpochSeconds(), traceId);
    emitIncidentMetric('IncidentCreated');
    let respondingUnits: readonly Record<string, unknown>[] = [];
    let respondingMembers: readonly unknown[] = [];
    if (dispatchId) {
      const client = getDocumentClient();
      const tableName = getTableName(process.env);
      [respondingUnits, respondingMembers] = await Promise.all([
        queryIncidentResponseUnits(client, tableName, deptId, incident.incidentId),
        queryRosterCopy(client, tableName, deptId, incident.incidentId),
      ]);
    }
    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...incident, respondingUnits, respondingMembers }),
    };
  } catch (error) {
    if (error instanceof DuplicateIncidentError) {
      console.error(
        JSON.stringify({
          event: 'incident.create.conflict',
          correlationId: traceId,
          deptId,
          dispatchNumber: input.dispatchNumber,
          message: error.message,
        }),
      );
      return problemResponse(409, 'Conflict', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.create.failed',
        correlationId: traceId,
        deptId,
        dispatchNumber: input.dispatchNumber,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentCreateFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to create incident.', traceId);
  }
};
