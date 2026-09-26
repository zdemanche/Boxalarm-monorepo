import { randomUUID } from 'node:crypto';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  deriveCertificationStatus,
  expireCertification,
  type CertificationStatus,
} from '../certificationRepository.js';
import {
  createDynamoClient,
  emitExpiryScanMetric,
  readTrainingDynamoConfig,
} from '../dynamoClient.js';
import { logError as logStructuredError } from '../logger.js';

export interface DueCertItem {
  readonly certId: string;
  readonly memberId: string;
  readonly expiryDate: string;
  readonly status: CertificationStatus;
}

export interface ExpiryScanResult {
  readonly scanned: number;
  readonly flipped: number;
}

function readExpiryScanConfig(env: NodeJS.ProcessEnv): { readonly deptId: string } {
  const deptId = env.DEPT_ID;
  if (!deptId) {
    throw new Error('DEPT_ID is required and was not set');
  }
  return { deptId };
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function priorMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
}

/** GSI2 DUE#CERTIFICATION#{yyyy-mm} partitions that can hold a cert that has just expired. */
export function expiryFlipMonths(now: Date): readonly string[] {
  return Array.from(new Set([monthKey(now), monthKey(priorMonth(now))]));
}

export interface FlipExpiredResult {
  readonly flipped: number;
  readonly failed: number;
}

/**
 * Writes status=EXPIRED (conditional on CURRENT, with an audit row) for every candidate whose
 * expiryDate has passed. That status write is the stream transition certExpiredReactor.ts
 * consumes to set MEMBER_QUALIFICATION.currentlyEligible=false (#221). One failed flip is
 * logged and counted, never allowed to stop the rest of the batch.
 */
export async function flipExpiredCertifications(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  deptId: VerifiedDeptId,
  candidates: readonly DueCertItem[],
  now: Date,
): Promise<FlipExpiredResult> {
  let flipped = 0;
  let failed = 0;
  await Promise.allSettled(
    candidates.map(async (item) => {
      if (
        item.status !== 'CURRENT' ||
        deriveCertificationStatus(item.status, item.expiryDate, now) !== 'EXPIRED'
      ) {
        return;
      }
      try {
        const didFlip = await expireCertification(client, env, {
          deptId,
          memberId: item.memberId,
          certId: item.certId,
          correlationId: randomUUID(),
          now,
        });
        if (didFlip) {
          flipped += 1;
        }
      } catch (error) {
        failed += 1;
        logError('training.expiryScan.flipFailed', error, {
          deptId,
          memberId: item.memberId,
          certId: item.certId,
        });
      }
    }),
  );
  emitExpiryScanMetric(flipped);
  return { flipped, failed };
}

function logError(event: string, error: unknown, context: Record<string, unknown>): void {
  logStructuredError({
    event,
    service: 'training',
    ...context,
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : undefined,
  });
}

async function queryDueMonth(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  yearMonth: string,
): Promise<readonly DueCertItem[]> {
  const items: DueCertItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2pk = :pk',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'DUE', 'CERTIFICATION', yearMonth),
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const item of result.Items ?? []) {
      items.push({
        certId: item.certId as string,
        memberId: item.memberId as string,
        expiryDate: item.expiryDate as string,
        status: item.status as CertificationStatus,
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

/**
 * Standalone entrypoint (DEPT_ID-configured). Not separately deployed: the daily
 * certificationExpiryScanner Lambda calls flipExpiredCertifications itself, so one schedule
 * both flips expired certs and publishes lead-time notifications.
 */
export const handler = async (): Promise<ExpiryScanResult> => {
  const { deptId: rawDeptId } = readExpiryScanConfig(process.env);
  const deptId = toVerifiedDeptId({ deptId: rawDeptId });
  const { tableName } = readTrainingDynamoConfig(process.env);
  const client = createDynamoClient();
  const now = new Date();
  const months = expiryFlipMonths(now);

  let dueItems: readonly DueCertItem[];
  try {
    const results = await Promise.all(
      months.map((yearMonth) => queryDueMonth(client, tableName, deptId, yearMonth)),
    );
    dueItems = results.flat();
  } catch (error) {
    logError('training.expiryScan.queryFailed', error, { deptId: rawDeptId });
    throw error;
  }

  const { flipped } = await flipExpiredCertifications(client, process.env, deptId, dueItems, now);
  return { scanned: dueItems.length, flipped };
};
