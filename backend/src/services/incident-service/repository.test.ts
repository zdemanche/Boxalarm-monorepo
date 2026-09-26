import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  DuplicateIncidentError,
  IncidentNotFoundError,
  InvalidIncidentStatusError,
  NarrativeTooLongError,
  createIncidentRepository,
  getDocumentClient,
  getTableName,
} from './repository.js';
import { buildNerisIncidentId, INCIDENT_STATUSES } from './entity.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE_NAME = 'boxalarm-dev-incident';
const TRACE_ID = 'trace-abc-123';

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

interface TransactPutItem {
  readonly Put: { readonly TableName: string; readonly Item: Record<string, unknown> };
}

interface TransactUpdateItem {
  readonly Update: {
    readonly Key: Record<string, string>;
    readonly ConditionExpression: string;
    readonly UpdateExpression: string;
    readonly ExpressionAttributeValues: Record<string, unknown>;
  };
}

function transactItems(send: ReturnType<typeof vi.fn>): unknown[] {
  const [command] = send.mock.calls[0] as [{ input: { TransactItems: unknown[] } }];
  return command.input.TransactItems;
}

function entityUpdate(send: ReturnType<typeof vi.fn>): TransactUpdateItem['Update'] {
  return (transactItems(send)[0] as TransactUpdateItem).Update;
}

function outboxPut(send: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined {
  return (transactItems(send)[1] as TransactPutItem | undefined)?.Put.Item;
}

function conditionFailedOnEntity(): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
  });
}

const BASE_INPUT = {
  dispatchNumber: '4471',
  epochSeconds: 1_798_000_000,
  nerisSchemaVersion: '2026.2',
  corePayload: { incident_type: 'STRUCTURE_FIRE', opaque: true },
  createdBy: 'MBR-0034',
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
  alarmAt: 1_798_000_000,
} as const;

describe('buildNerisIncidentId', () => {
  it('composes incidentId as deptId-dispatchNumber-epochSeconds (same as dispatchId)', () => {
    expect(buildNerisIncidentId('NICHOLS', '4471', 1_798_000_000)).toBe('NICHOLS-4471-1798000000');
  });
});

describe('INCIDENT_STATUSES', () => {
  it('accepts only DRAFT, VALIDATED, SUBMITTED, ACCEPTED, REJECTED', () => {
    expect([...INCIDENT_STATUSES]).toEqual([
      'DRAFT',
      'VALIDATED',
      'SUBMITTED',
      'ACCEPTED',
      'REJECTED',
    ]);
  });
});

describe('createIncidentRepository', () => {
  it('persists INCIDENT with pk DEPT#deptId#INCIDENT#incidentId, sk METADATA, nerisSchemaVersion, and opaque corePayload (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);
    const now = 1_798_000_100;

    const result = await repository.createIncident(DEPT_ID, BASE_INPUT, now, TRACE_ID);

    const expectedId = 'NICHOLS-4471-1798000000';
    expect(result).toMatchObject({
      incidentId: expectedId,
      sourceDispatchId: expectedId,
      deptId: 'NICHOLS',
      dispatchNumber: '4471',
      epochSeconds: 1_798_000_000,
      nerisSchemaVersion: '2026.2',
      corePayload: BASE_INPUT.corePayload,
      status: 'DRAFT',
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
    });

    const [command] = send.mock.calls[0] as [{ input: { TransactItems: TransactPutItem[] } }];
    const incidentPut = command.input.TransactItems[0]?.Put;
    expect(incidentPut).toMatchObject({
      TableName: TABLE_NAME,
      Item: {
        pk: `DEPT#NICHOLS#INCIDENT#${expectedId}`,
        sk: 'METADATA',
        entityType: 'INCIDENT',
        incidentId: expectedId,
        sourceDispatchId: expectedId,
        nerisSchemaVersion: '2026.2',
        corePayload: BASE_INPUT.corePayload,
        status: 'DRAFT',
        gsi1pk: 'DEPT#NICHOLS',
        gsi1sk: 'INCIDENT#1798000000',
      },
    });
    expect(
      (command.input.TransactItems[0] as { Put: { ConditionExpression?: string } }).Put,
    ).toMatchObject({ ConditionExpression: 'attribute_not_exists(pk)' });
  });

  it('writes an AUDIT_LOG_ENTRY for the create in the same transaction (regression for PR #149 finding 1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);
    const expectedId = 'NICHOLS-4471-1798000000';

    await repository.createIncident(DEPT_ID, BASE_INPUT, 1_798_000_100, TRACE_ID);

    const [command] = send.mock.calls[0] as [{ input: { TransactItems: TransactPutItem[] } }];
    const auditItem = command.input.TransactItems[1]?.Put.Item;
    expect(auditItem?.pk).toMatch(/^DEPT#NICHOLS#AUDIT#\d{4}-\d{2}-\d{2}$/);
    expect(auditItem).toMatchObject({
      entityType: 'AUDIT_LOG_ENTRY',
      mutatedEntityType: 'INCIDENT',
      mutatedEntityId: expectedId,
      action: 'CREATE',
      actorId: 'MBR-0034',
      gsi3pk: `DEPT#NICHOLS#AUDIT#ENTITY#INCIDENT#${expectedId}`,
    });
  });

  it('writes an OUTBOX_ENTRY for incident.created carrying the caller traceId as correlationId (regression for PR #149 finding 1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);
    const expectedId = 'NICHOLS-4471-1798000000';

    await repository.createIncident(DEPT_ID, BASE_INPUT, 1_798_000_100, TRACE_ID);

    const [command] = send.mock.calls[0] as [{ input: { TransactItems: TransactPutItem[] } }];
    const outboxItem = command.input.TransactItems[2]?.Put.Item;
    expect(outboxItem).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'incident.created',
      source: 'incident-service',
      correlationId: TRACE_ID,
      payload: {
        incidentId: expectedId,
        deptId: 'NICHOLS',
        dispatchNumber: '4471',
        status: 'DRAFT',
        createdBy: 'MBR-0034',
      },
    });
  });

  it('sets incidentId equal to the originating dispatch NERIS-format ID (AC3)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.createIncident(DEPT_ID, BASE_INPUT, 1_798_000_100, TRACE_ID);

    expect(result.incidentId).toBe(buildNerisIncidentId('NICHOLS', '4471', 1_798_000_000));
    expect(result.incidentId).toBe(result.sourceDispatchId);
  });

  it('rejects a status outside DRAFT|VALIDATED|SUBMITTED|ACCEPTED|REJECTED (AC4)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.createIncident(
        DEPT_ID,
        { ...BASE_INPUT, status: 'OPEN' as 'DRAFT' },
        1_798_000_100,
        TRACE_ID,
      ),
    ).rejects.toThrow(InvalidIncidentStatusError);
    expect(send).not.toHaveBeenCalled();
  });

  it('persists an explicit VALIDATED status when provided', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.createIncident(
      DEPT_ID,
      { ...BASE_INPUT, status: 'VALIDATED' },
      1_798_000_100,
      TRACE_ID,
    );

    expect(result.status).toBe('VALIDATED');
    const [command] = send.mock.calls[0] as [{ input: { TransactItems: TransactPutItem[] } }];
    expect(command.input.TransactItems[0]?.Put.Item.status).toBe('VALIDATED');
  });

  it('gets an incident by pk/sk via GetItem', async () => {
    const item = {
      pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
      sk: 'METADATA',
      entityType: 'INCIDENT',
      incidentId: 'NICHOLS-4471-1798000000',
      deptId: 'NICHOLS',
      dispatchNumber: '4471',
      epochSeconds: 1_798_000_000,
      nerisSchemaVersion: '2026.2',
      corePayload: { opaque: true },
      status: 'DRAFT',
      sourceDispatchId: 'NICHOLS-4471-1798000000',
      createdBy: 'MBR-0034',
      createdAt: 1_798_000_100,
      updatedAt: 1_798_000_100,
    };
    const send = vi.fn().mockResolvedValue({ Item: item });
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.getIncident(DEPT_ID, 'NICHOLS-4471-1798000000');

    expect(result).toMatchObject({
      incidentId: 'NICHOLS-4471-1798000000',
      nerisSchemaVersion: '2026.2',
      corePayload: { opaque: true },
      status: 'DRAFT',
    });
    const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input).toMatchObject({
      TableName: TABLE_NAME,
      Key: {
        pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
        sk: 'METADATA',
      },
    });
  });

  it('returns undefined when no incident matches', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(repository.getIncident(DEPT_ID, 'NICHOLS-9999-1')).resolves.toBeUndefined();
  });

  it('rejects a duplicate incidentId as DuplicateIncidentError when the transact write cancels on the incident condition', async () => {
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      }),
    );
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.createIncident(DEPT_ID, BASE_INPUT, 1_798_000_100, TRACE_ID),
    ).rejects.toThrow(DuplicateIncidentError);
  });

  it('rethrows a non-conditional transact write failure without masking it as a duplicate', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.createIncident(DEPT_ID, BASE_INPUT, 1_798_000_100, TRACE_ID),
    ).rejects.toThrow('DynamoDB unavailable');
  });

  it('sets incidentId to an explicit override when provided (E6-S2 dispatch-linked creation)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.createIncident(
      DEPT_ID,
      { ...BASE_INPUT, incidentId: 'NICHOLS-MANUAL-1798000000-abcd1234' },
      1_798_000_100,
      TRACE_ID,
    );

    expect(result.incidentId).toBe('NICHOLS-MANUAL-1798000000-abcd1234');
  });

  it('updates the narrative denormalized field and corePayload.narrative (E6-S4 AC1)', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
        sk: 'METADATA',
        incidentId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        dispatchNumber: '4471',
        epochSeconds: 1_798_000_000,
        nerisSchemaVersion: '2026.2',
        corePayload: { narrative: 'updated narrative' },
        narrative: 'updated narrative',
        status: 'DRAFT',
        sourceDispatchId: 'NICHOLS-4471-1798000000',
        createdBy: 'MBR-0034',
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.updateNarrative(
      DEPT_ID,
      'NICHOLS-4471-1798000000',
      'updated narrative',
      2,
      TRACE_ID,
    );

    expect(result.narrative).toBe('updated narrative');
    expect(entityUpdate(send)).toMatchObject({
      Key: { pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000', sk: 'METADATA' },
      ConditionExpression: 'attribute_exists(pk)',
    });
  });

  it('rejects a narrative over the max length without writing (E6-S4 AC2)', async () => {
    const send = vi.fn();
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.updateNarrative(
        DEPT_ID,
        'NICHOLS-4471-1798000000',
        'x'.repeat(25_001),
        2,
        TRACE_ID,
      ),
    ).rejects.toThrow(NarrativeTooLongError);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a narrative update for a nonexistent incident as IncidentNotFoundError', async () => {
    const send = vi.fn().mockRejectedValue(conditionFailedOnEntity());
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.updateNarrative(DEPT_ID, 'NICHOLS-9999', 'test', 2, TRACE_ID),
    ).rejects.toThrow(IncidentNotFoundError);
  });

  it('replaces corePayload and status on a guided-completion update (E6-S3 AC2)', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
        sk: 'METADATA',
        incidentId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        dispatchNumber: '4471',
        epochSeconds: 1_798_000_000,
        nerisSchemaVersion: '2026.2',
        corePayload: { incident_type: 'STRUCTURE_FIRE', action_taken: 'EXTINGUISH' },
        status: 'VALIDATED',
        sourceDispatchId: 'NICHOLS-4471-1798000000',
        createdBy: 'MBR-0034',
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.updateCorePayload(
      DEPT_ID,
      'NICHOLS-4471-1798000000',
      { incident_type: 'STRUCTURE_FIRE', action_taken: 'EXTINGUISH' },
      'VALIDATED',
      2,
      TRACE_ID,
    );

    expect(result.status).toBe('VALIDATED');
    expect(entityUpdate(send)).toMatchObject({
      Key: { pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000', sk: 'METADATA' },
      ConditionExpression: 'attribute_exists(pk)',
    });
  });

  it(
    'syncs the denormalized top-level incidentType/address fields from corePayload so search ' +
      'summaries stay in sync after guided completion sets incident_type (regression for PR #316 MAJOR finding)',
    async () => {
      const send = vi.fn().mockResolvedValue({
        Item: {
          pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
          sk: 'METADATA',
          incidentId: 'NICHOLS-4471-1798000000',
          deptId: 'NICHOLS',
          dispatchNumber: '4471',
          epochSeconds: 1_798_000_000,
          nerisSchemaVersion: '2026.2',
          corePayload: {
            incident_type: 'STRUCTURE_FIRE',
            action_taken: 'EXTINGUISH',
            address: '123 Main St',
          },
          incidentType: 'STRUCTURE_FIRE',
          address: '123 Main St',
          status: 'VALIDATED',
          sourceDispatchId: 'NICHOLS-4471-1798000000',
          createdBy: 'MBR-0034',
          createdAt: 1,
          updatedAt: 2,
        },
      });
      const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

      const result = await repository.updateCorePayload(
        DEPT_ID,
        'NICHOLS-4471-1798000000',
        {
          incident_type: 'STRUCTURE_FIRE',
          action_taken: 'EXTINGUISH',
          address: '123 Main St',
        },
        'VALIDATED',
        2,
        TRACE_ID,
      );

      expect(result.incidentType).toBe('STRUCTURE_FIRE');
      expect(result.address).toBe('123 Main St');
      const update = entityUpdate(send);
      expect(update.UpdateExpression).toMatch(/incidentType = :incidentType/);
      expect(update.UpdateExpression).toMatch(/address = :address/);
      expect(update.ExpressionAttributeValues[':incidentType']).toBe('STRUCTURE_FIRE');
      expect(update.ExpressionAttributeValues[':address']).toBe('123 Main St');
    },
  );

  it('leaves the denormalized top-level fields untouched when corePayload has no matching keys', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
        sk: 'METADATA',
        incidentId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        dispatchNumber: '4471',
        epochSeconds: 1_798_000_000,
        nerisSchemaVersion: '2026.2',
        corePayload: { action_taken: 'EXTINGUISH' },
        status: 'DRAFT',
        sourceDispatchId: 'NICHOLS-4471-1798000000',
        createdBy: 'MBR-0034',
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await repository.updateCorePayload(
      DEPT_ID,
      'NICHOLS-4471-1798000000',
      { action_taken: 'EXTINGUISH' },
      'DRAFT',
      2,
      TRACE_ID,
    );

    const update = entityUpdate(send);
    expect(update.UpdateExpression).not.toMatch(/incidentType/);
    expect(update.UpdateExpression).not.toMatch(/address/);
  });

  it('rejects updateCorePayload on a nonexistent incident as IncidentNotFoundError', async () => {
    const send = vi.fn().mockRejectedValue(conditionFailedOnEntity());
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.updateCorePayload(DEPT_ID, 'NICHOLS-9999', {}, 'VALIDATED', 2, TRACE_ID),
    ).rejects.toThrow(IncidentNotFoundError);
  });

  it('writes an incident.narrative.updated OUTBOX_ENTRY atomically with the narrative update, without the narrative text', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { incidentId: 'NICHOLS-4471-1798000000' } });
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await repository.updateNarrative(
      DEPT_ID,
      'NICHOLS-4471-1798000000',
      'secret text',
      2,
      TRACE_ID,
    );

    const outbox = outboxPut(send);
    expect(outbox).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'incident.narrative.updated',
      source: 'incident-service',
      correlationId: TRACE_ID,
      payload: { incidentId: 'NICHOLS-4471-1798000000', deptId: 'NICHOLS', updatedAt: 2 },
    });
    expect(JSON.stringify(outbox)).not.toContain('secret text');
  });

  it('writes an incident.updated OUTBOX_ENTRY atomically with the core-payload update', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { incidentId: 'NICHOLS-4471-1798000000' } });
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await repository.updateCorePayload(
      DEPT_ID,
      'NICHOLS-4471-1798000000',
      { incident_type: 'STRUCTURE_FIRE' },
      'VALIDATED',
      2,
      TRACE_ID,
    );

    expect(outboxPut(send)).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'incident.updated',
      correlationId: TRACE_ID,
      payload: {
        incidentId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        status: 'VALIDATED',
        incidentType: 'STRUCTURE_FIRE',
      },
    });
  });

  it('returns the committed incident via a strongly consistent read-back', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: { incidentId: 'NICHOLS-4471-1798000000', narrative: 'n', status: 'DRAFT' },
    });
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.updateNarrative(
      DEPT_ID,
      'NICHOLS-4471-1798000000',
      'n',
      2,
      TRACE_ID,
    );

    expect(result.narrative).toBe('n');
    const [readBack] = send.mock.calls[1] as [{ input: Record<string, unknown> }];
    expect(readBack.input).toMatchObject({
      Key: { pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000', sk: 'METADATA' },
      ConsistentRead: true,
    });
  });

  it('rethrows a non-conditional update failure without masking it as not-found', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.updateCorePayload(DEPT_ID, 'NICHOLS-4471-1798000000', {}, 'DRAFT', 2, TRACE_ID),
    ).rejects.toThrow('DynamoDB unavailable');
  });

  it('searches incidents by alarm-time range via GSI1, ordered by alarm time (E6-S10 AC1)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { incidentId: 'A', incidentType: 'STRUCTURE_FIRE', alarmAt: 100, status: 'DRAFT' },
        { incidentId: 'B', incidentType: 'VEHICLE_FIRE', alarmAt: 200, status: 'VALIDATED' },
      ],
    });
    const repository = createIncidentRepository(fakeClient(send), TABLE_NAME);

    const results = await repository.searchIncidents(DEPT_ID, { fromAlarmAt: 0, toAlarmAt: 300 });

    expect(results.map((incident) => incident.incidentId)).toEqual(['A', 'B']);
    const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input).toMatchObject({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      ExpressionAttributeValues: {
        ':pk': 'DEPT#NICHOLS',
        ':from': 'INCIDENT#0',
        ':to': 'INCIDENT#300',
      },
    });
  });
});

describe('getTableName', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when INCIDENT_TABLE_NAME is unset', () => {
    const env = { ...process.env };
    delete env.INCIDENT_TABLE_NAME;
    expect(() => getTableName(env)).toThrow(/INCIDENT_TABLE_NAME/);
  });

  it('returns the configured table name when set', () => {
    expect(getTableName({ INCIDENT_TABLE_NAME: 'boxalarm-dev-incident' })).toBe(
      'boxalarm-dev-incident',
    );
  });
});

describe('getDocumentClient', () => {
  it('memoizes the DynamoDB document client across calls', () => {
    expect(getDocumentClient()).toBe(getDocumentClient());
  });
});
