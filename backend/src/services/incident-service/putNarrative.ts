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
  NarrativeTooLongError,
  getIncidentRepository,
} from './repository.js';

function parseNarrative(record: Record<string, unknown>): string {
  const narrative = record.narrative;
  if (typeof narrative !== 'string') {
    throw new RequestValidationError('narrative is required and must be a string');
  }
  return narrative;
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const request = readIncidentWriteRequest(event, 'incident.narrative.denied', parseNarrative);
  if (!request.ok) {
    return request.response;
  }
  const { traceId, deptId, incidentId, input: narrative } = request;

  try {
    const repository = getIncidentRepository(process.env);
    const incident = await repository.updateNarrative(
      deptId,
      incidentId,
      narrative,
      nowEpochSeconds(),
      traceId,
    );
    emitIncidentMetric('IncidentNarrativeUpdated');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incident),
    };
  } catch (error) {
    if (error instanceof NarrativeTooLongError) {
      return problemResponse(400, 'Bad Request', error.message, traceId);
    }
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.narrative.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentNarrativeUpdateFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to update the incident narrative.',
      traceId,
    );
  }
};
