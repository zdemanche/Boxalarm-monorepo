import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { assertNoDelimiter, buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord, type OutboxRecord } from '@boxalarm/outbox';
import {
  buildNerisIncidentId,
  isIncidentStatus,
  type CreateIncidentInput,
  type Incident,
  type IncidentStatus,
} from './entity.js';

export interface SearchIncidentsInput {
  readonly fromAlarmAt: number;
  readonly toAlarmAt: number;
}

export interface IncidentRepository {
  createIncident(
    deptId: VerifiedDeptId,
    input: CreateIncidentInput,
    nowEpochSeconds: number,
    traceId: string,
  ): Promise<Incident>;
  getIncident(deptId: VerifiedDeptId, incidentId: string): Promise<Incident | undefined>;
  updateNarrative(
    deptId: VerifiedDeptId,
    incidentId: string,
    narrative: string,
    nowEpochSeconds: number,
    traceId: string,
  ): Promise<Incident>;
  updateCorePayload(
    deptId: VerifiedDeptId,
    incidentId: string,
    corePayload: Readonly<Record<string, unknown>>,
    status: IncidentStatus,
    nowEpochSeconds: number,
    traceId: string,
  ): Promise<Incident>;
  searchIncidents(
    deptId: VerifiedDeptId,
    input: SearchIncidentsInput,
  ): Promise<readonly Incident[]>;
}

export class IncidentNotFoundError extends Error {
  constructor(incidentId: string) {
    super(`no incident found with incidentId "${incidentId}"`);
    this.name = 'IncidentNotFoundError';
  }
}

export const MAX_NARRATIVE_LENGTH = 25_000;

export class NarrativeTooLongError extends Error {
  constructor(length: number) {
    super(`narrative must not exceed ${MAX_NARRATIVE_LENGTH} characters; received ${length}`);
    this.name = 'NarrativeTooLongError';
  }
}

export class DuplicateIncidentError extends Error {
  constructor(incidentId: string) {
    super(`incident with incidentId "${incidentId}" already exists`);
    this.name = 'DuplicateIncidentError';
  }
}

export class InvalidIncidentStatusError extends Error {
  constructor(status: string) {
    super(
      `status must be one of DRAFT, VALIDATED, SUBMITTED, ACCEPTED, REJECTED; received "${status}"`,
    );
    this.name = 'InvalidIncidentStatusError';
  }
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function getDocumentClient(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}

export function getTableName(env: NodeJS.ProcessEnv): string {
  const tableName = env.INCIDENT_TABLE_NAME;
  if (!tableName) {
    throw new Error('INCIDENT_TABLE_NAME is required and was not set');
  }
  return tableName;
}

function toIncident(item: Record<string, unknown>): Incident {
  return {
    incidentId: item.incidentId as string,
    deptId: item.deptId as string,
    dispatchNumber: item.dispatchNumber as string,
    epochSeconds: item.epochSeconds as number,
    nerisSchemaVersion: item.nerisSchemaVersion as string,
    corePayload: item.corePayload as Readonly<Record<string, unknown>>,
    ...(typeof item.incidentType === 'string' ? { incidentType: item.incidentType } : {}),
    ...(typeof item.address === 'string' ? { address: item.address } : {}),
    ...(typeof item.latitude === 'number' ? { latitude: item.latitude } : {}),
    ...(typeof item.longitude === 'number' ? { longitude: item.longitude } : {}),
    ...(typeof item.alarmAt === 'number' ? { alarmAt: item.alarmAt } : {}),
    ...(typeof item.dispatchAt === 'number' ? { dispatchAt: item.dispatchAt } : {}),
    ...(typeof item.arrivedAt === 'number' ? { arrivedAt: item.arrivedAt } : {}),
    ...(typeof item.clearedAt === 'number' ? { clearedAt: item.clearedAt } : {}),
    ...(typeof item.narrative === 'string' ? { narrative: item.narrative } : {}),
    status: item.status as IncidentStatus,
    sourceDispatchId: item.sourceDispatchId as string,
    createdBy: item.createdBy as string,
    createdAt: item.createdAt as number,
    updatedAt: item.updatedAt as number,
  };
}

function resolveStatus(input: CreateIncidentInput): IncidentStatus {
  if (input.status === undefined) {
    return 'DRAFT';
  }
  if (!isIncidentStatus(input.status)) {
    throw new InvalidIncidentStatusError(String(input.status));
  }
  return input.status;
}

/** True when a TransactWrite was cancelled by the condition on its item at `index`. */
export function isConditionFailureAt(error: unknown, index: number): boolean {
  return (
    error instanceof TransactionCanceledException &&
    error.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed'
  );
}

export function createIncidentRepository(
  client: DynamoDBDocumentClient,
  tableName: string,
): IncidentRepository {
  const metadataKey = (deptId: VerifiedDeptId, incidentId: string) => ({
    pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
    sk: 'METADATA',
  });

  // Every incident mutation that raises an event commits its entity Update and its
  // OUTBOX_ENTRY Put atomically (the house outbox pattern createIncident follows).
  // TransactWriteItems can't return ALL_NEW, so the committed item is read back with a
  // strongly consistent Get.
  async function updateWithOutbox(
    deptId: VerifiedDeptId,
    incidentId: string,
    update: {
      readonly UpdateExpression: string;
      readonly ExpressionAttributeValues: Record<string, unknown>;
      readonly ExpressionAttributeNames?: Record<string, string>;
    },
    outboxRecord: OutboxRecord<unknown>,
  ): Promise<Incident> {
    const Key = metadataKey(deptId, incidentId);
    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key,
                ConditionExpression: 'attribute_exists(pk)',
                ...update,
              },
            },
            { Put: { TableName: tableName, Item: outboxRecord } },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailureAt(error, 0)) {
        throw new IncidentNotFoundError(incidentId);
      }
      throw error;
    }
    const result = await client.send(
      new GetCommand({ TableName: tableName, Key, ConsistentRead: true }),
    );
    if (!result.Item) {
      throw new IncidentNotFoundError(incidentId);
    }
    return toIncident(result.Item as Record<string, unknown>);
  }

  return {
    async createIncident(deptId, input, nowEpochSeconds, traceId) {
      assertNoDelimiter(input.dispatchNumber, 'dispatchNumber');
      const status = resolveStatus(input);
      const incidentId =
        input.incidentId ?? buildNerisIncidentId(deptId, input.dispatchNumber, input.epochSeconds);
      const alarmAt = input.alarmAt ?? input.epochSeconds;
      const item = {
        pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
        sk: 'METADATA',
        entityType: 'INCIDENT',
        incidentId,
        deptId,
        dispatchNumber: input.dispatchNumber,
        epochSeconds: input.epochSeconds,
        nerisSchemaVersion: input.nerisSchemaVersion,
        corePayload: input.corePayload,
        ...(input.incidentType !== undefined ? { incidentType: input.incidentType } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
        ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
        ...(input.alarmAt !== undefined ? { alarmAt: input.alarmAt } : {}),
        ...(input.dispatchAt !== undefined ? { dispatchAt: input.dispatchAt } : {}),
        ...(input.arrivedAt !== undefined ? { arrivedAt: input.arrivedAt } : {}),
        ...(input.clearedAt !== undefined ? { clearedAt: input.clearedAt } : {}),
        ...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
        status,
        sourceDispatchId: incidentId,
        createdBy: input.createdBy,
        createdAt: nowEpochSeconds,
        updatedAt: nowEpochSeconds,
        gsi1pk: buildDeptScopedPk(deptId),
        gsi1sk: `INCIDENT#${alarmAt}`,
      };

      // Audit entry shape matches the sibling create-path precedent (memberRepository.ts's
      // createMember, equipmentRepository.ts's writeAuditLogEntry): a durable AUDIT_LOG_ENTRY
      // row co-located in this service's own table so it commits atomically with the entity.
      const auditTs = Date.now();
      const auditDate = new Date(auditTs).toISOString().slice(0, 10);
      const auditItem = {
        pk: buildDeptScopedPk(deptId, 'AUDIT', auditDate),
        sk: `${auditTs}#INCIDENT#${incidentId}#${input.createdBy}`,
        entityType: 'AUDIT_LOG_ENTRY',
        mutatedEntityType: 'INCIDENT',
        mutatedEntityId: incidentId,
        action: 'CREATE',
        actorId: input.createdBy,
        changedFields: {
          status: { old: null, new: status },
          dispatchNumber: { old: null, new: input.dispatchNumber },
        },
        ts: auditTs,
        gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'INCIDENT', incidentId),
        gsi3sk: String(auditTs),
      };

      // Lean payload (not the full corePayload) keeps the outbox item well under the
      // per-item DynamoDB limit and matches the sibling outbox precedent (defectRepository.ts,
      // hydrantRepository.ts) of publishing identifiers/summary fields, not the full entity.
      const outboxRecord = buildOutboxRecord(
        deptId,
        'incident-service',
        'incident.created',
        traceId,
        {
          incidentId,
          deptId,
          dispatchNumber: input.dispatchNumber,
          status,
          createdBy: input.createdBy,
        },
      );

      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: item,
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: auditItem,
                  ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
                },
              },
              { Put: { TableName: tableName, Item: outboxRecord } },
            ],
          }),
        );
      } catch (error) {
        if (isConditionFailureAt(error, 0)) {
          throw new DuplicateIncidentError(incidentId);
        }
        throw error;
      }
      return toIncident(item);
    },

    async getIncident(deptId, incidentId) {
      const result = await client.send(
        new GetCommand({ TableName: tableName, Key: metadataKey(deptId, incidentId) }),
      );
      return result.Item ? toIncident(result.Item as Record<string, unknown>) : undefined;
    },

    async updateNarrative(deptId, incidentId, narrative, nowEpochSeconds, traceId) {
      if (narrative.length > MAX_NARRATIVE_LENGTH) {
        throw new NarrativeTooLongError(narrative.length);
      }
      // Lean payload: identifiers only, not the (up to 25k-char) narrative text.
      const outboxRecord = buildOutboxRecord(
        deptId,
        'incident-service',
        'incident.narrative.updated',
        traceId,
        { incidentId, deptId, updatedAt: nowEpochSeconds },
      );
      return updateWithOutbox(
        deptId,
        incidentId,
        {
          UpdateExpression:
            'SET narrative = :narrative, corePayload.narrative = :narrative, updatedAt = :updatedAt',
          ExpressionAttributeValues: { ':narrative': narrative, ':updatedAt': nowEpochSeconds },
        },
        outboxRecord,
      );
    },

    async updateCorePayload(deptId, incidentId, corePayload, status, nowEpochSeconds, traceId) {
      const setClauses = [
        'corePayload = :corePayload',
        '#status = :status',
        'updatedAt = :updatedAt',
      ];
      const values: Record<string, unknown> = {
        ':corePayload': corePayload,
        ':status': status,
        ':updatedAt': nowEpochSeconds,
      };

      // Keep the denormalized top-level fields createIncident also stores (and that
      // searchIncidents.ts/GSI1 summaries and getIncident read directly, never corePayload)
      // in sync whenever guided completion sets the corresponding corePayload field. Guided
      // completion is the common path that finalizes incident_type, since it's optional at
      // create and one of the two requiredFields this flow exists to fill in — leaving the
      // top-level field unsynced would make search summaries go stale relative to corePayload.
      const incidentType = corePayload.incident_type;
      if (typeof incidentType === 'string') {
        setClauses.push('incidentType = :incidentType');
        values[':incidentType'] = incidentType;
      }
      const address = corePayload.address;
      if (typeof address === 'string') {
        setClauses.push('address = :address');
        values[':address'] = address;
      }

      const outboxRecord = buildOutboxRecord(
        deptId,
        'incident-service',
        'incident.updated',
        traceId,
        {
          incidentId,
          deptId,
          status,
          ...(typeof incidentType === 'string' ? { incidentType } : {}),
          updatedAt: nowEpochSeconds,
        },
      );
      return updateWithOutbox(
        deptId,
        incidentId,
        {
          UpdateExpression: `SET ${setClauses.join(', ')}`,
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: values,
        },
        outboxRecord,
      );
    },

    async searchIncidents(deptId, input) {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to',
          ExpressionAttributeValues: {
            ':pk': buildDeptScopedPk(deptId),
            ':from': `INCIDENT#${input.fromAlarmAt}`,
            ':to': `INCIDENT#${input.toAlarmAt}`,
          },
        }),
      );
      return (result.Items ?? []).map((item) => toIncident(item as Record<string, unknown>));
    },
  };
}

let cachedRepository: IncidentRepository | undefined;

export function getIncidentRepository(env: NodeJS.ProcessEnv): IncidentRepository {
  cachedRepository ??= createIncidentRepository(getDocumentClient(), getTableName(env));
  return cachedRepository;
}
