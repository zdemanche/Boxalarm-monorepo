import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  tooManyRequestsProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { deriveIngressIdempotencyKey } from '../dispatches/dispatchIngressPort.js';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError } from '../dispatches/logger.js';
import { createManualDispatch } from '../dispatches/repository.js';
import { SELF_TEST_CHANNELS, selfTestAdapter } from './dispatchAdapter.js';
import { acquireSelfTestCooldown, upsertSelfTestRun } from './selfTestRunRepository.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingSelfTest';

async function postSelfTest(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;
  const runAt = Math.floor(Date.now() / 1000);
  const testId = `${memberId}-${runAt}-${randomUUID().slice(0, 8)}`;

  const normalized = selfTestAdapter.normalize({ testId });
  if (!normalized.ok) {
    logError('selfTest.post.invalidPayload', new Error('self-test normalize failed'), {
      traceId,
      deptId,
      memberId,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SelfTestTriggerFailed', 'InvalidPayload');
    return badRequestProblem(traceId, 'unable to construct the self-test dispatch payload');
  }

  let tableName: string;
  let client: ReturnType<typeof createDynamoClient>;
  try {
    tableName = readAlertingConfig(process.env).tableName;
    client = createDynamoClient(process.env);
  } catch (error) {
    logError('selfTest.post.configError', error, { traceId, deptId, memberId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SelfTestTriggerFailed', 'ConfigError');
    return serviceUnavailableProblem(traceId);
  }

  let cooldownAcquired: boolean;
  try {
    cooldownAcquired = await acquireSelfTestCooldown(client, tableName, deptId, memberId, runAt);
  } catch (error) {
    logError('selfTest.post.cooldownCheckFailed', error, { traceId, deptId, memberId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SelfTestTriggerFailed', 'DynamoUnavailable');
    return serviceUnavailableProblem(traceId);
  }
  if (!cooldownAcquired) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'SelfTestTriggerFailed', 'CooldownActive');
    return tooManyRequestsProblem(
      traceId,
      'self-test was triggered too recently; wait before trying again',
    );
  }

  const idempotencyKey = deriveIngressIdempotencyKey(
    deptId,
    normalized.value.sourceSystem,
    normalized.value.externalDispatchId,
  );

  try {
    const result = await createManualDispatch(client, tableName, {
      deptId,
      dispatch: normalized.value,
      idempotencyKey,
      dispatchedAt: runAt,
      targetMemberId: memberId,
      selfTestId: testId,
      channelsTested: SELF_TEST_CHANNELS,
    });

    if (result.outcome === 'duplicate') {
      logError('selfTest.post.unexpectedDuplicate', new Error('self-test idempotency collision'), {
        traceId,
        deptId,
        memberId,
        testId,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'SelfTestTriggerFailed', 'DuplicateSubmission');
      return tooManyRequestsProblem(traceId, 'a self-test with this testId is already in progress');
    }

    await upsertSelfTestRun(
      client,
      tableName,
      {
        deptId,
        memberId,
        testId,
        runAt,
        channelsTested: SELF_TEST_CHANNELS,
        channelResults: {},
        overallResult: 'RUNNING',
      },
      { onlyIfAbsent: true },
    );

    emitOutcomeMetric(METRIC_NAMESPACE, 'SelfTestTriggered');
    return {
      statusCode: 202,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        testId,
        dispatchId: result.dispatchId,
        status: 'RUNNING',
      }),
    };
  } catch (error) {
    logError('selfTest.post.createFailed', error, { traceId, deptId, memberId, testId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SelfTestTriggerFailed', 'DynamoUnavailable');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(postSelfTest, {
  actionType: 'Boxalarm::Action',
  actionId: 'SelfTestAlertPath',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});
