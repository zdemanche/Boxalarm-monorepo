import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { IncidentNotFoundError, isConditionFailureAt } from './repository.js';

const TIME_FIELDS = ['dispatchedAt', 'enRouteAt', 'arrivedAt', 'clearedAt'] as const;
type TimeField = (typeof TIME_FIELDS)[number];

export interface ResponseUnitTimesInput {
  readonly deptId: VerifiedDeptId;
  readonly incidentId: string;
  readonly unitId: string;
  readonly unitType: 'APPARATUS' | 'MEMBER';
  readonly times: Partial<Record<TimeField, number>>;
}

export interface ResponseUnit {
  readonly incidentId: string;
  readonly unitId: string;
  readonly unitType: string;
  readonly dispatchedAt?: number;
  readonly enRouteAt?: number;
  readonly arrivedAt?: number;
  readonly clearedAt?: number;
}

function toResponseUnit(item: Record<string, unknown>): ResponseUnit {
  return {
    incidentId: item.incidentId as string,
    unitId: item.unitId as string,
    unitType: item.unitType as string,
    ...(typeof item.dispatchedAt === 'number' ? { dispatchedAt: item.dispatchedAt } : {}),
    ...(typeof item.enRouteAt === 'number' ? { enRouteAt: item.enRouteAt } : {}),
    ...(typeof item.arrivedAt === 'number' ? { arrivedAt: item.arrivedAt } : {}),
    ...(typeof item.clearedAt === 'number' ? { clearedAt: item.clearedAt } : {}),
  };
}

/**
 * Independently settable per-timestamp update (E6-S5 AC1/AC2): only the fields present in
 * `times` are written, so editing one timestamp never disturbs the others or the
 * assignedPositions ridingAssignmentConsumer.ts already wrote for this unit (E6-S5 AC2).
 * Commits atomically with an `incident.response_unit.updated` OUTBOX_ENTRY.
 */
export async function upsertResponseUnitTimes(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: ResponseUnitTimesInput,
  traceId: string,
): Promise<ResponseUnit> {
  const responseUnitKey = {
    pk: buildDeptScopedPk(input.deptId, 'INCIDENT', input.incidentId),
    sk: `RESPONSE#${input.unitId}`,
  };

  const setClauses = [
    'entityType = :entityType',
    'unitType = :unitType',
    'unitId = :unitId',
    'incidentId = :incidentId',
  ];
  const values: Record<string, unknown> = {
    ':entityType': 'INCIDENT_RESPONSE_UNIT',
    ':unitType': input.unitType,
    ':unitId': input.unitId,
    ':incidentId': input.incidentId,
  };
  for (const field of TIME_FIELDS) {
    const value = input.times[field];
    if (value !== undefined) {
      setClauses.push(`${field} = :${field}`);
      values[`:${field}`] = value;
    }
  }

  const outboxRecord = buildOutboxRecord(
    input.deptId,
    'incident-service',
    'incident.response_unit.updated',
    traceId,
    {
      incidentId: input.incidentId,
      deptId: input.deptId,
      unitId: input.unitId,
      unitType: input.unitType,
      ...input.times,
    },
  );

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          // Guard against a bad incidentId silently creating an orphan RESPONSE#{unitId}
          // item: the Update's own condition can't, since RESPONSE# is a different sk and
          // the first-ever write for a unit must still create it. The parent INCIDENT
          // METADATA existence check rides in the same transaction instead.
          {
            ConditionCheck: {
              TableName: tableName,
              Key: {
                pk: buildDeptScopedPk(input.deptId, 'INCIDENT', input.incidentId),
                sk: 'METADATA',
              },
              ConditionExpression: 'attribute_exists(pk)',
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: responseUnitKey,
              UpdateExpression: `SET ${setClauses.join(', ')}`,
              ExpressionAttributeValues: values,
            },
          },
          { Put: { TableName: tableName, Item: outboxRecord } },
        ],
      }),
    );
  } catch (error) {
    if (isConditionFailureAt(error, 0)) {
      throw new IncidentNotFoundError(input.incidentId);
    }
    throw error;
  }

  // TransactWriteItems can't return ALL_NEW; read the committed row back.
  const result = await client.send(
    new GetCommand({ TableName: tableName, Key: responseUnitKey, ConsistentRead: true }),
  );
  return toResponseUnit(result.Item as Record<string, unknown>);
}
