import { randomUUID } from 'node:crypto';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf, emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { deriveIngressIdempotencyKey } from '../dispatches/dispatchIngressPort.js';
import { createManualDispatch } from '../dispatches/repository.js';
import { SELF_TEST_CHANNELS, selfTestAdapter } from '../selfTest/dispatchAdapter.js';
import {
  acquireSelfTestCooldown,
  getSelfTestRun,
  upsertSelfTestRun,
} from '../selfTest/selfTestRunRepository.js';
import {
  clearCanaryPointer,
  getCanaryPointer,
  putCanaryRun,
  setCanaryPointer,
  type CanaryResult,
} from './canaryRunRepository.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingCanary';
// N1's 5s p99 ingress-to-delivery budget (architecture.compiled/components/alerting-service.md).
const LATENCY_BUDGET_MS = 5_000;

export interface CanaryConfig {
  readonly deptId: string;
  readonly canaryMemberId: string;
}

export function readCanaryConfig(env: NodeJS.ProcessEnv): CanaryConfig {
  const deptId = env.CANARY_DEPT_ID;
  const canaryMemberId = env.CANARY_MEMBER_ID;
  if (!deptId) {
    throw new Error('CANARY_DEPT_ID is required and was not set');
  }
  if (!canaryMemberId) {
    throw new Error('CANARY_MEMBER_ID is required and was not set');
  }
  return { deptId, canaryMemberId };
}

async function completePendingRun(
  ddb: ReturnType<typeof createDynamoClient>,
  tableName: string,
  deptId: ReturnType<typeof toVerifiedDeptId>,
  memberId: string,
  now: number,
  nowMs: number,
): Promise<void> {
  const pointer = await getCanaryPointer(ddb, tableName, deptId);
  if (!pointer) {
    return;
  }
  const run = await getSelfTestRun(ddb, tableName, deptId, memberId, pointer.pendingTestId);
  const overallResult = run?.overallResult;
  const completedAtMs = typeof run?.completedAtMs === 'number' ? run.completedAtMs : undefined;
  const startedAtMs = pointer.pendingRunAtMs ?? pointer.pendingRunAt * 1000;
  // Latency is the self-test run's own start-to-completion time (fan-out stamps completedAtMs
  // when it writes the final result) — never this tick's clock, which trails the run by the
  // whole schedule interval and would make every run FAIL. A run that has not completed has no
  // completion time; its elapsed time so far is a lower bound and the run is a FAIL.
  const latencyMs = Math.max((completedAtMs ?? nowMs) - startedAtMs, 0);

  let result: CanaryResult;
  if (overallResult === 'PASS' && completedAtMs !== undefined && latencyMs <= LATENCY_BUDGET_MS) {
    result = 'PASS';
  } else {
    result = 'FAIL';
  }

  await putCanaryRun(ddb, tableName, {
    deptId,
    testId: pointer.pendingTestId,
    ranAt: now,
    result,
    latencyMs,
    channelResults: (run?.channelResults as Record<string, unknown> | undefined) ?? {},
  });

  // Clear the pointer now that this pendingTestId has been recorded, regardless of whether
  // startNextRun below manages to arm a new one. Otherwise, if startNextRun's cooldown
  // acquisition fails (the schedule can run more often than the 60s self-test cooldown), this
  // same stale pendingTestId would be re-read and re-recorded on the next invocation — writing a
  // duplicate CANARY_RUN item (keyed on ranAt, not testId) with an ever-growing latencyMs for a
  // self-test that already resolved.
  await clearCanaryPointer(ddb, tableName, deptId);

  emitOutcomeMetric(METRIC_NAMESPACE, result === 'PASS' ? 'CanaryPassed' : 'CanaryFailed');
  emitEmf(METRIC_NAMESPACE, 'CanaryLatencyMs', latencyMs, [[]], {}, 'Milliseconds');
  logInfo('alerting.canary.result', { deptId, testId: pointer.pendingTestId, result, latencyMs });
}

async function startNextRun(
  ddb: ReturnType<typeof createDynamoClient>,
  tableName: string,
  deptId: ReturnType<typeof toVerifiedDeptId>,
  memberId: string,
  now: number,
  nowMs: number,
): Promise<void> {
  const cooldownAcquired = await acquireSelfTestCooldown(ddb, tableName, deptId, memberId, now);
  if (!cooldownAcquired) {
    logInfo('alerting.canary.skippedCooldown', { deptId });
    return;
  }

  const testId = `canary-${now}-${randomUUID().slice(0, 8)}`;
  const normalized = selfTestAdapter.normalize({ testId });
  if (!normalized.ok) {
    logError('alerting.canary.normalizeFailed', new Error('canary payload normalize failed'), {
      deptId,
    });
    return;
  }
  const idempotencyKey = deriveIngressIdempotencyKey(
    deptId,
    normalized.value.sourceSystem,
    normalized.value.externalDispatchId,
  );

  const result = await createManualDispatch(ddb, tableName, {
    deptId,
    dispatch: normalized.value,
    idempotencyKey,
    dispatchedAt: now,
    targetMemberId: memberId,
    selfTestId: testId,
    channelsTested: SELF_TEST_CHANNELS,
  });
  if (result.outcome === 'duplicate') {
    logError('alerting.canary.unexpectedDuplicate', new Error('canary idempotency collision'), {
      deptId,
      testId,
    });
    return;
  }

  await upsertSelfTestRun(
    ddb,
    tableName,
    {
      deptId,
      memberId,
      testId,
      runAt: now,
      channelsTested: SELF_TEST_CHANNELS,
      channelResults: {},
      overallResult: 'RUNNING',
    },
    { onlyIfAbsent: true },
  );

  await setCanaryPointer(ddb, tableName, deptId, {
    pendingTestId: testId,
    pendingRunAt: now,
    pendingRunAtMs: nowMs,
  });
}

export const handler = async (): Promise<void> => {
  const config = readCanaryConfig(process.env);
  const deptId = toVerifiedDeptId({ deptId: config.deptId });
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);

  try {
    await completePendingRun(ddb, tableName, deptId, config.canaryMemberId, now, nowMs);
  } catch (error) {
    logError('alerting.canary.completeFailed', error, { deptId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'CanaryEvaluationFailed');
  }

  try {
    await startNextRun(ddb, tableName, deptId, config.canaryMemberId, now, nowMs);
  } catch (error) {
    logError('alerting.canary.startFailed', error, { deptId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'CanaryTriggerFailed');
  }
};
