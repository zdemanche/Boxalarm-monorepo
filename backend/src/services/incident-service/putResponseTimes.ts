import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import {
  RequestValidationError,
  emitIncidentMetric,
  problemResponse,
  readIncidentWriteRequest,
} from './authContext.js';
import { IncidentNotFoundError, getDocumentClient, getTableName } from './repository.js';
import { upsertResponseUnitTimes, type ResponseUnitTimesInput } from './responseUnitRepository.js';

const UNIT_TYPES = ['APPARATUS', 'MEMBER'] as const;
const TIME_FIELDS = ['dispatchedAt', 'enRouteAt', 'arrivedAt', 'clearedAt'] as const;

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RequestValidationError(`${key} must be a finite number`);
  }
  return value;
}

function parseInput(
  record: Record<string, unknown>,
): Omit<ResponseUnitTimesInput, 'deptId' | 'incidentId'> {
  const unitId = record.unitId;
  if (typeof unitId !== 'string' || unitId.trim().length === 0) {
    throw new RequestValidationError('unitId is required and must be a non-empty string');
  }
  assertNoDelimiter(unitId, 'unitId');

  const unitType = record.unitType;
  if (typeof unitType !== 'string' || !(UNIT_TYPES as readonly string[]).includes(unitType)) {
    throw new RequestValidationError(`unitType must be one of: ${UNIT_TYPES.join(', ')}`);
  }

  const times: Partial<Record<(typeof TIME_FIELDS)[number], number>> = {};
  for (const field of TIME_FIELDS) {
    const value = optionalNumber(record, field);
    if (value !== undefined) {
      times[field] = value;
    }
  }

  return { unitId, unitType: unitType as 'APPARATUS' | 'MEMBER', times };
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const request = readIncidentWriteRequest(event, 'incident.responseTimes.denied', parseInput);
  if (!request.ok) {
    return request.response;
  }
  const { traceId, deptId, incidentId, input: input } = request;

  try {
    const client = getDocumentClient();
    const tableName = getTableName(process.env);
    const unit = await upsertResponseUnitTimes(
      client,
      tableName,
      { deptId, incidentId, ...input },
      traceId,
    );
    emitIncidentMetric('IncidentResponseTimesUpdated');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(unit),
    };
  } catch (error) {
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.responseTimes.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentResponseTimesFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to record response times.', traceId);
  }
};
