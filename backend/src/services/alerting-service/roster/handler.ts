import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  extractTraceId,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError } from '../dispatches/logger.js';
import { queryRoster } from './repository.js';

async function innerHandler(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const dispatchId = event.pathParameters?.dispatchId;
  if (!dispatchId) {
    return notFoundProblem(traceId, 'dispatchId path parameter is required');
  }

  const deptId = toVerifiedDeptId(principal);

  try {
    const config = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);
    const roster = await queryRoster(client, config.tableName, deptId, dispatchId);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dispatchId,
        members: roster.map((entry) => ({
          memberId: entry.memberId,
          ackStatus: entry.ackStatus,
          ackAt: entry.ackAt,
          eta: entry.eta,
          assignedApparatusId: entry.assignedApparatusId,
          quals: entry.quals,
          lastAnsweredTone: entry.lastAnsweredTone,
        })),
      }),
    };
  } catch (error) {
    logError('roster.read.unavailable', error, { deptId, dispatchId });
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerHandler, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewRoster',
  resourceType: 'Boxalarm::Dispatch',
  resourceId: (event) => event.pathParameters?.dispatchId ?? '',
});
