import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import {
  RequestValidationError,
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  readIncidentWriteRequest,
} from './authContext.js';
import {
  IncidentNotFoundError,
  getDocumentClient,
  getIncidentRepository,
  getTableName,
} from './repository.js';
import { createSchemaVersionRepository } from './schemaVersion/repository.js';
import { getCoreSchemaDocument } from './schemaVersion/s3Schema.js';
import { getS3Client } from '../platform-service/export/awsClients.js';
import { missingRequiredCoreFields, validateCoreFields } from './schemaVersion/validateEnum.js';

function parseFields(body: Record<string, unknown>): Record<string, string> {
  const fields = body.fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new RequestValidationError(
      'fields is required and must be a JSON object of field:value pairs',
    );
  }
  const record = fields as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      throw new RequestValidationError(`field "${key}" must be a string`);
    }
    result[key] = value;
  }
  return result;
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const request = readIncidentWriteRequest(event, 'incident.update.denied', parseFields);
  if (!request.ok) {
    return request.response;
  }
  const { traceId, deptId, incidentId, input: fields } = request;

  try {
    const repository = getIncidentRepository(process.env);
    const incident = await repository.getIncident(deptId, incidentId);
    if (!incident) {
      return problemResponse(
        404,
        'Not Found',
        `No incident found with incidentId "${incidentId}".`,
        traceId,
      );
    }

    const client = getDocumentClient();
    const tableName = getTableName(process.env);
    const schemaVersionRepository = createSchemaVersionRepository(client, tableName);
    // Validate against the schema version this incident was authored under, not whatever
    // is newest: the scheduled refresh job can promote a new ACTIVE schema at any time, and
    // re-validating an older incident against it would apply enum/requiredFields rules it was
    // never authored under. Falls back to ACTIVE only when the pinned version can't be
    // resolved at all (e.g. the 'UNVALIDATED' sentinel createIncident.ts's dispatch-linked
    // path uses when no schema was ACTIVE yet at create time).
    const schema =
      (await schemaVersionRepository.getSchemaVersion(incident.nerisSchemaVersion)) ??
      (await schemaVersionRepository.getActiveSchemaVersion());
    if (!schema) {
      return problemResponse(
        503,
        'Service Unavailable',
        'No active NERIS schema version is published.',
        traceId,
      );
    }
    const coreSchema = await getCoreSchemaDocument(
      getS3Client(),
      process.env.NERIS_SCHEMA_BUCKET_NAME ?? '',
      schema.coreSchemaS3Key,
    );

    const errors = validateCoreFields(coreSchema, fields);
    if (errors.length > 0) {
      return problemResponse(
        400,
        'Bad Request',
        'One or more fields failed NERIS enumeration validation.',
        traceId,
        { errors },
      );
    }

    const mergedFields = { ...incident.corePayload, ...fields } as Record<string, string>;
    const missing = missingRequiredCoreFields(coreSchema, mergedFields);
    const nextStatus = missing.length === 0 ? 'VALIDATED' : incident.status;

    const updated = await repository.updateCorePayload(
      deptId,
      incidentId,
      mergedFields,
      nextStatus,
      nowEpochSeconds(),
      traceId,
    );

    emitIncidentMetric('IncidentUpdated');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    };
  } catch (error) {
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.update.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentUpdateFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to update the incident.', traceId);
  }
};
