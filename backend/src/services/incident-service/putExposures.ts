import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import {
  RequestValidationError,
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  readIncidentWriteRequest,
} from './authContext.js';
import { getDocumentClient, getIncidentRepository, getTableName } from './repository.js';
import { putIncidentSecondary } from './secondaryRepository.js';
import { createSchemaVersionRepository } from './schemaVersion/repository.js';
import { getSecondarySchemaDocument } from './schemaVersion/s3Schema.js';
import { getS3Client } from '../platform-service/export/awsClients.js';
import {
  missingRequiredSecondaryFields,
  validateSecondaryFields,
} from './schemaVersion/validateEnum.js';

interface ParsedExposureInput {
  readonly secondaryType: string;
  readonly payload: Record<string, string>;
  readonly affectedMemberIds: readonly string[];
}

function parseInput(record: Record<string, unknown>): ParsedExposureInput {
  const secondaryType = record.secondaryType;
  if (typeof secondaryType !== 'string' || secondaryType.trim().length === 0) {
    throw new RequestValidationError('secondaryType is required and must be a non-empty string');
  }
  assertNoDelimiter(secondaryType, 'secondaryType');

  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new RequestValidationError('payload is required and must be a JSON object');
  }
  const payloadRecord = payload as Record<string, unknown>;
  const stringPayload: Record<string, string> = {};
  for (const [key, value] of Object.entries(payloadRecord)) {
    if (typeof value !== 'string') {
      throw new RequestValidationError(`payload field "${key}" must be a string`);
    }
    stringPayload[key] = value;
  }

  const affectedMemberIds = record.affectedMemberIds;
  if (
    !Array.isArray(affectedMemberIds) ||
    !affectedMemberIds.every((id) => typeof id === 'string')
  ) {
    throw new RequestValidationError(
      'affectedMemberIds is required and must be an array of strings',
    );
  }

  return { secondaryType, payload: stringPayload, affectedMemberIds };
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const request = readIncidentWriteRequest(event, 'incident.exposures.denied', parseInput);
  if (!request.ok) {
    return request.response;
  }
  const { traceId, deptId, incidentId, input: input } = request;

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
    const secondarySchema = await getSecondarySchemaDocument(
      getS3Client(),
      process.env.NERIS_SCHEMA_BUCKET_NAME ?? '',
      schema.secondarySchemaS3Key,
    );

    const errors = validateSecondaryFields(secondarySchema, input.secondaryType, input.payload);
    if (errors.length > 0) {
      return problemResponse(
        400,
        'Bad Request',
        'One or more fields failed NERIS Secondary enumeration validation.',
        traceId,
        { errors },
      );
    }

    const missing = missingRequiredSecondaryFields(
      secondarySchema,
      input.secondaryType,
      input.payload,
    );
    const updatedAt = nowEpochSeconds();
    await putIncidentSecondary(
      client,
      tableName,
      deptId,
      {
        incidentId,
        secondaryType: input.secondaryType,
        payload: input.payload,
        affectedMemberIds: input.affectedMemberIds,
        updatedAt,
      },
      traceId,
    );

    emitIncidentMetric('IncidentSecondaryUpdated');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incidentId,
        secondaryType: input.secondaryType,
        payload: input.payload,
        affectedMemberIds: input.affectedMemberIds,
        complete: missing.length === 0,
        updatedAt,
      }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.exposures.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentSecondaryFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to record the Secondary-schema module.',
      traceId,
    );
  }
};
