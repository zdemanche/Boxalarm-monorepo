import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

const CANARY_RUN_TTL_SECONDS = 60 * 60 * 24 * 90;

export interface CanaryPointer {
  readonly pendingTestId: string;
  /** Epoch seconds the pending self-test was armed. */
  readonly pendingRunAt: number;
  /** Epoch ms the pending self-test was armed; absent on pointers written before it existed. */
  readonly pendingRunAtMs?: number;
}

export async function getCanaryPointer(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<CanaryPointer | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'CANARY'), sk: 'STATE' },
    }),
  );
  const item = result.Item;
  if (!item || typeof item.pendingTestId !== 'string' || typeof item.pendingRunAt !== 'number') {
    return undefined;
  }
  return {
    pendingTestId: item.pendingTestId,
    pendingRunAt: item.pendingRunAt,
    ...(typeof item.pendingRunAtMs === 'number' ? { pendingRunAtMs: item.pendingRunAtMs } : {}),
  };
}

export async function setCanaryPointer(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  pointer: CanaryPointer,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: buildDeptScopedPk(deptId, 'CANARY'),
        sk: 'STATE',
        entityType: 'CANARY_STATE',
        ...pointer,
      },
    }),
  );
}

export async function clearCanaryPointer(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'CANARY'), sk: 'STATE' },
    }),
  );
}

export type CanaryResult = 'PASS' | 'FAIL';

export interface CanaryRunInput {
  readonly deptId: VerifiedDeptId;
  readonly testId: string;
  readonly ranAt: number;
  readonly result: CanaryResult;
  readonly latencyMs: number;
  readonly channelResults: Readonly<Record<string, unknown>>;
}

function dateKey(ranAt: number): string {
  return new Date(ranAt * 1000).toISOString().slice(0, 10);
}

export async function putCanaryRun(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  input: CanaryRunInput,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: buildDeptScopedPk(input.deptId, 'CANARY', dateKey(input.ranAt)),
        sk: `RUN#${input.ranAt}`,
        entityType: 'CANARY_RUN',
        deptId: input.deptId,
        testId: input.testId,
        ranAt: input.ranAt,
        result: input.result,
        latencyMs: input.latencyMs,
        channelResults: input.channelResults,
        ttl: input.ranAt + CANARY_RUN_TTL_SECONDS,
      },
    }),
  );
}

export async function queryLatestCanaryRuns(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dateKeyValue: string,
  limit: number,
): Promise<readonly Record<string, unknown>[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'CANARY', dateKeyValue) },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return result.Items ?? [];
}

export { dateKey as canaryDateKey };
