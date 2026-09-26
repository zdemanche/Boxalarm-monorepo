import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError } from '../dispatches/logger.js';
import { queryMemberDiagnostics } from './queryDiagnostics.js';

async function getDiagnostics(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  memberId: string,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const dispatchId = event.pathParameters?.dispatchId;
  if (!dispatchId) {
    return badRequestProblem(traceId, 'dispatchId path parameter is required');
  }
  const deptId = toVerifiedDeptId(principal);

  try {
    const { tableName } = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);
    const diagnostics = await queryMemberDiagnostics(
      client,
      tableName,
      deptId,
      dispatchId,
      memberId,
    );

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dispatchId,
        memberId,
        diagnosis: diagnostics.onEligibleRoster ? 'ON_ROSTER' : 'NOT_ON_ELIGIBLE_ROSTER',
        timeline: diagnostics.timeline,
        deviceState: diagnostics.deviceState,
      }),
    };
  } catch (error) {
    logError('diagnostics.read_failed', error, { traceId, deptId, dispatchId, memberId });
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(
  (event, principal) => getDiagnostics(event, principal, event.pathParameters?.memberId ?? ''),
  {
    actionType: 'Boxalarm::Action',
    actionId: 'ViewDiagnostics',
    resourceType: 'Boxalarm::Dispatch',
    resourceId: (event) => event.pathParameters?.dispatchId ?? '',
  },
);
