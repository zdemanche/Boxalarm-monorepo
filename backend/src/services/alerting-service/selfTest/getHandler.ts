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
import { getSelfTestRun } from './selfTestRunRepository.js';

async function getSelfTest(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const testId = event.pathParameters?.testId;
  if (!testId) {
    return notFoundProblem(traceId, 'testId path parameter is required');
  }

  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;

  let tableName: string;
  let client: ReturnType<typeof createDynamoClient>;
  try {
    tableName = readAlertingConfig(process.env).tableName;
    client = createDynamoClient(process.env);
  } catch (error) {
    logError('selfTest.get.configError', error, { traceId, deptId, memberId, testId });
    return serviceUnavailableProblem(traceId);
  }

  let item: Record<string, unknown> | undefined;
  try {
    item = await getSelfTestRun(client, tableName, deptId, memberId, testId);
  } catch (error) {
    logError('selfTest.get.readFailed', error, { traceId, deptId, memberId, testId });
    return serviceUnavailableProblem(traceId);
  }

  if (!item) {
    return notFoundProblem(traceId, `self-test run ${testId} was not found`);
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      testId: item.testId,
      runAt: item.runAt,
      channelsTested: item.channelsTested,
      channelResults: item.channelResults,
      overallResult: item.overallResult,
    }),
  };
}

export const handler = withAuthorization(getSelfTest, {
  actionType: 'Boxalarm::Action',
  actionId: 'SelfTestAlertPath',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});
