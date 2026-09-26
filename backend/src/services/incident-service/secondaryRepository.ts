import {
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { assertNoDelimiter, buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';

export interface IncidentSecondary {
  readonly incidentId: string;
  readonly secondaryType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly affectedMemberIds: readonly string[];
  readonly updatedAt: number;
}

/** Writes the Secondary module and its `incident.secondary.updated` OUTBOX_ENTRY atomically. */
export async function putIncidentSecondary(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  secondary: IncidentSecondary,
  traceId: string,
): Promise<void> {
  // Enforced here, not only at the API boundary, since both values become key segments.
  assertNoDelimiter(secondary.incidentId, 'incidentId');
  assertNoDelimiter(secondary.secondaryType, 'secondaryType');
  const outboxRecord = buildOutboxRecord(
    deptId,
    'incident-service',
    'incident.secondary.updated',
    traceId,
    {
      incidentId: secondary.incidentId,
      deptId,
      secondaryType: secondary.secondaryType,
      affectedMemberIds: secondary.affectedMemberIds,
      updatedAt: secondary.updatedAt,
    },
  );
  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: buildDeptScopedPk(deptId, 'INCIDENT', secondary.incidentId),
              sk: `SECONDARY#${secondary.secondaryType}`,
              entityType: 'INCIDENT_SECONDARY',
              incidentId: secondary.incidentId,
              secondaryType: secondary.secondaryType,
              payload: secondary.payload,
              affectedMemberIds: secondary.affectedMemberIds,
              updatedAt: secondary.updatedAt,
            },
          },
        },
        { Put: { TableName: tableName, Item: outboxRecord } },
      ],
    }),
  );
}

/** AC3: each Secondary module comes back as its own distinct record, never merged. */
export async function queryIncidentSecondaries(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
): Promise<readonly IncidentSecondary[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
        ':prefix': 'SECONDARY#',
      },
    }),
  );
  return (result.Items ?? []) as unknown as IncidentSecondary[];
}
