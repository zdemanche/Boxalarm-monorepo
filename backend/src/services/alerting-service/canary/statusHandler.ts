import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError } from '../dispatches/logger.js';
import { canaryDateKey, queryLatestCanaryRuns } from './canaryRunRepository.js';

const RUNS_TO_RETURN = 20;

async function getCanaryStatus(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);

  try {
    const { tableName } = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);
    const today = canaryDateKey(Math.floor(Date.now() / 1000));
    const runs = await queryLatestCanaryRuns(client, tableName, deptId, today, RUNS_TO_RETURN);

    const latest = runs[0];
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        healthy: latest?.result === 'PASS',
        latestResult: latest?.result ?? null,
        latestLatencyMs: latest?.latencyMs ?? null,
        latestRanAt: latest?.ranAt ?? null,
        runs,
      }),
    };
  } catch (error) {
    logError('canary.status.read_failed', error, { traceId, deptId });
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(getCanaryStatus, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewCanaryStatus',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
