import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { Handler, ScheduledEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { queryCertificationsDueInMonth } from '../certificationRepository.js';
import { createDynamoClient } from '../dynamoClient.js';
import { expiryFlipMonths, flipExpiredCertifications } from '../certifications/expiryScan.js';
import {
  monthPartitionsForScan,
  readCertExpiryLeadDays,
  selectWithinLeadTime,
} from './configReader.js';
import { createEventBridgeClient, publishDueEvent } from './publishDueEvents.js';

const METRIC_NAMESPACE = 'Boxalarm/cert-expiry-scanner';
const SERVICE_NAME = 'training';
const PUBLISH_CONCURRENCY = 10;

async function publishWithBoundedConcurrency(
  dueRecords: readonly {
    readonly memberId: string;
    readonly certId: string;
    readonly expiryDate: string;
  }[],
  publish: (record: (typeof dueRecords)[number]) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < dueRecords.length; start += PUBLISH_CONCURRENCY) {
    const chunk = dueRecords.slice(start, start + PUBLISH_CONCURRENCY);
    await Promise.all(chunk.map((record) => publish(record)));
  }
}

function readScannerDeptId(env: NodeJS.ProcessEnv): string {
  const deptId = env.TRAINING_SCANNER_DEPT_ID;
  if (!deptId) {
    throw new Error('TRAINING_SCANNER_DEPT_ID is required and was not set');
  }
  return deptId;
}

export interface CertificationExpiryScannerDeps {
  readonly dynamoClient?: DynamoDBDocumentClient;
  readonly eventBridgeClient?: EventBridgeClient;
  readonly now?: Date;
}

export async function runCertificationExpiryScan(
  correlationId: string,
  deps: CertificationExpiryScannerDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  const deptId = toVerifiedDeptId({ deptId: readScannerDeptId(process.env) });
  const ddb = createDynamoClient(deps.dynamoClient);
  const eb = createEventBridgeClient(deps.eventBridgeClient);

  try {
    const leadDays = await readCertExpiryLeadDays(ddb, process.env, deptId, correlationId);
    // Lead-time partitions (current month forward) plus the prior month, so a cert that
    // expired late last month is still flipped to EXPIRED on this run.
    const monthPartitions = Array.from(
      new Set([...expiryFlipMonths(now), ...monthPartitionsForScan(now, leadDays)]),
    );
    const results = await Promise.all(
      monthPartitions.map((yearMonth) =>
        queryCertificationsDueInMonth(ddb, process.env, { deptId, yearMonth, correlationId }),
      ),
    );
    const allRecords = results.flat();

    // #221: the stored status must actually become EXPIRED — certExpiredReactor.ts only
    // reacts to that stream transition, and it is what clears currentlyEligible for the
    // alerting eligibility snapshot. Done first: it is the life-safety half of this job.
    const flip = await flipExpiredCertifications(ddb, process.env, deptId, allRecords, now);

    const dueRecords = selectWithinLeadTime(allRecords, now, leadDays);

    emitOutcomeMetric(METRIC_NAMESPACE, 'Scanned');
    await publishWithBoundedConcurrency(dueRecords, (record) =>
      publishDueEvent(ddb, eb, process.env, {
        deptId,
        memberId: record.memberId,
        certId: record.certId,
        expiryDate: record.expiryDate,
        leadDays,
        correlationId,
        now,
      }).then(() => undefined),
    );

    // Fail the invocation (Errors alarm, scheduler retry) rather than let an unflipped
    // expired cert leave a member alert-eligible silently. Every step above is idempotent.
    if (flip.failed > 0) {
      throw new Error(`${flip.failed} expired certification(s) could not be flipped to EXPIRED`);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'certificationExpiryScanner.scan.failed',
        service: SERVICE_NAME,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        correlationId,
        deptId,
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'ScanFailed');
    throw error;
  }
}

export const handler: Handler<ScheduledEvent, void> = async (event) => {
  await runCertificationExpiryScan(event.id);
};
