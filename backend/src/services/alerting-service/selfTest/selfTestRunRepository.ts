import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export const SELF_TEST_METRIC_NAMESPACE = 'Boxalarm/AlertingSelfTest';

const SELF_TEST_RUN_TTL_SECONDS = 60 * 60 * 24 * 365;
export const SELF_TEST_COOLDOWN_SECONDS = 60;

export interface SelfTestChannelResult {
  readonly ok: boolean;
  readonly ms: number;
  readonly reason?: string;
}

export interface SelfTestRunItem {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly testId: string;
  readonly runAt: number;
  readonly channelsTested: readonly string[];
  readonly channelResults: Readonly<Record<string, SelfTestChannelResult>>;
  readonly overallResult: 'PASS' | 'FAIL' | 'RUNNING';
  readonly eligibilityReason?: string;
  /**
   * Epoch ms at which fan-out finished the run and wrote its final PASS/FAIL. The canary
   * measures its ingress-to-delivery latency against this, not against its own next tick.
   */
  readonly completedAtMs?: number;
}

export async function upsertSelfTestRun(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  input: SelfTestRunItem,
  options: { readonly onlyIfAbsent?: boolean } = {},
): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(input.deptId, 'MEMBER', input.memberId),
          sk: `SELFTEST#${input.testId}`,
          entityType: 'SELF_TEST_RUN',
          deptId: input.deptId,
          memberId: input.memberId,
          testId: input.testId,
          runAt: input.runAt,
          channelsTested: input.channelsTested,
          channelResults: input.channelResults,
          overallResult: input.overallResult,
          ...(input.eligibilityReason ? { eligibilityReason: input.eligibilityReason } : {}),
          ...(input.completedAtMs !== undefined ? { completedAtMs: input.completedAtMs } : {}),
          ttl: input.runAt + SELF_TEST_RUN_TTL_SECONDS,
        },
        ...(options.onlyIfAbsent ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
      }),
    );
  } catch (error) {
    if (options.onlyIfAbsent && error instanceof ConditionalCheckFailedException) {
      return;
    }
    throw error;
  }
}

export async function getSelfTestRun(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  testId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: `SELFTEST#${testId}` },
    }),
  );
  return result.Item;
}

export async function acquireSelfTestCooldown(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  runAt: number,
): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
          sk: 'SELFTEST_COOLDOWN',
          entityType: 'SELF_TEST_COOLDOWN',
          deptId,
          memberId,
          expiresAt: runAt + SELF_TEST_COOLDOWN_SECONDS,
          ttl: runAt + SELF_TEST_COOLDOWN_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': runAt },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw error;
  }
}
