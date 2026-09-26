import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { assertNoDelimiter, buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export interface DispatchAlertCopy {
  readonly dispatchId: string;
  readonly deptId: VerifiedDeptId;
  readonly incidentType: string;
  readonly address: string;
  readonly crossStreets: string;
  readonly narrative: string;
  readonly dispatchedAt: number;
}

export interface RosterCopyEntry {
  readonly memberId: string;
  readonly status: string;
  readonly ackAt: number;
}

function dispatchCopyKey(deptId: VerifiedDeptId, dispatchId: string): { pk: string; sk: string } {
  return { pk: buildDeptScopedPk(deptId, 'DISPATCH_COPY', dispatchId), sk: 'METADATA' };
}

export async function putDispatchAlertCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  copy: DispatchAlertCopy,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...dispatchCopyKey(copy.deptId, copy.dispatchId),
        entityType: 'DISPATCH_ALERT_COPY',
        dispatchId: copy.dispatchId,
        deptId: copy.deptId,
        incidentType: copy.incidentType,
        address: copy.address,
        crossStreets: copy.crossStreets,
        narrative: copy.narrative,
        dispatchedAt: copy.dispatchedAt,
      },
    }),
  );
}

export async function getDispatchAlertCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<DispatchAlertCopy | undefined> {
  const result = await client.send(
    new GetCommand({ TableName: tableName, Key: dispatchCopyKey(deptId, dispatchId) }),
  );
  return result.Item as DispatchAlertCopy | undefined;
}

/** Last-writer-wins on ackAt (mirrors alerting-service's DISPATCH_ROSTER_ENTRY semantics). */
export async function putRosterCopyEntryIfNewer(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  entry: RosterCopyEntry,
): Promise<'updated' | 'stale'> {
  // Both come off an event payload and become key segments; enforce here rather than
  // trusting every producer/consumer to have validated them.
  assertNoDelimiter(dispatchId, 'dispatchId');
  assertNoDelimiter(entry.memberId, 'memberId');
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'DISPATCH_COPY', dispatchId),
          sk: `ROSTER#${entry.memberId}`,
          entityType: 'DISPATCH_ROSTER_COPY',
          deptId,
          dispatchId,
          memberId: entry.memberId,
          status: entry.status,
          ackAt: entry.ackAt,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR ackAt <= :new',
        ExpressionAttributeValues: { ':new': entry.ackAt },
      }),
    );
    return 'updated';
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return 'stale';
    }
    throw error;
  }
}

export async function queryRosterCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<readonly RosterCopyEntry[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'DISPATCH_COPY', dispatchId),
        ':prefix': 'ROSTER#',
      },
    }),
  );
  return (result.Items ?? []) as RosterCopyEntry[];
}

export async function queryIncidentResponseUnits(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
): Promise<readonly Record<string, unknown>[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
        ':prefix': 'RESPONSE#',
      },
    }),
  );
  return (result.Items ?? []) as Record<string, unknown>[];
}
