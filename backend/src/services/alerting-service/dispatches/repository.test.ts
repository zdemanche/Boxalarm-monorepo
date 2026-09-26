import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createManualDispatch, getDispatchById } from './repository.js';
import { deriveIngressIdempotencyKey } from './dispatchIngressPort.js';
import type { DispatchReceived } from './dispatchIngressPort.js';

const TABLE_NAME = 'alerting-dispatches-test';

describe('createManualDispatch (real DynamoDB, AC2/AC4)', () => {
  let container: StartedLocalStackContainer;
  let client: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    const base = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await base.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    client = DynamoDBDocumentClient.from(base);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  function dispatchPayload(
    externalDispatchId: string,
    sourceSystem: DispatchReceived['sourceSystem'] = 'MANUAL',
  ): DispatchReceived {
    return {
      sourceSystem,
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      crossStreets: 'Main & Elm',
      unitsRequested: ['ENGINE-2'],
      narrative: 'Smoke showing',
      externalDispatchId,
    };
  }

  async function outboxRowsFor(
    deptId: string,
    dispatchId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: 'correlationId = :dispatchId',
        ExpressionAttributeValues: { ':pk': `DEPT#${deptId}#OUTBOX`, ':dispatchId': dispatchId },
      }),
    );
    return result.Items ?? [];
  }

  describe('dispatch.alert.received bridge outbox write (PR #324 producer)', () => {
    it.each(['MANUAL', 'CAD'] as const)(
      'writes exactly one dispatch.alert.received OUTBOX_ENTRY for a %s dispatch, in the shape the incident consumer parses',
      async (sourceSystem) => {
        const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
        const externalId = `outbox-${sourceSystem}-${randomUUID()}`;
        const result = await createManualDispatch(client, TABLE_NAME, {
          deptId,
          dispatch: dispatchPayload(externalId, sourceSystem),
          idempotencyKey: deriveIngressIdempotencyKey(deptId, sourceSystem, externalId),
          dispatchedAt: 1798000000,
        });
        const dispatchId = result.outcome === 'created' ? result.dispatchId : '';
        expect(dispatchId).not.toBe('');

        const rows = await outboxRowsFor(deptId, dispatchId);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row).toMatchObject({
          entityType: 'OUTBOX_ENTRY',
          eventType: 'dispatch.alert.received',
          source: 'alerting-service',
          correlationId: dispatchId,
          schemaVersion: '1.0',
          sentAt: null,
        });
        expect(row.payload).toEqual({
          deptId,
          dispatchId,
          incidentType: 'STRUCTURE_FIRE',
          address: '123 Main St',
          crossStreets: 'Main & Elm',
          narrative: 'Smoke showing',
          dispatchedAt: 1798000000,
        });
        expect(typeof (row.payload as { dispatchedAt: unknown }).dispatchedAt).toBe('number');
        expect(typeof row.ttl).toBe('number');
      },
    );

    it('writes no outbox row for a SELF_TEST dispatch, so a member self-test never reaches the LOB bus (survivor)', async () => {
      const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
      const testId = `selftest-outbox-${randomUUID()}`;
      const result = await createManualDispatch(client, TABLE_NAME, {
        deptId,
        dispatch: dispatchPayload(testId, 'SELF_TEST'),
        idempotencyKey: deriveIngressIdempotencyKey(deptId, 'SELF_TEST', testId),
        dispatchedAt: 1798000000,
        targetMemberId: 'mbr-1',
        selfTestId: testId,
        channelsTested: ['PUSH'],
      });
      const dispatchId = result.outcome === 'created' ? result.dispatchId : '';
      expect(dispatchId).not.toBe('');

      const alert = await client.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`, sk: 'METADATA' },
        }),
      );
      expect(alert.Item?.isTest).toBe(true);
      expect(await outboxRowsFor(deptId, dispatchId)).toHaveLength(0);
    });

    it('leaves exactly one outbox row when the same dispatch is submitted twice (the cancelled transaction writes none)', async () => {
      const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
      const externalId = `outbox-dup-${randomUUID()}`;
      // The retry mints a fresh dispatchId, so count by a narrative unique to this
      // submission rather than by correlationId — a leaked second row would carry
      // the second dispatchId.
      const narrative = `dup-narrative-${randomUUID()}`;
      const input = {
        deptId,
        dispatch: { ...dispatchPayload(externalId), narrative },
        idempotencyKey: deriveIngressIdempotencyKey(deptId, 'MANUAL', externalId),
        dispatchedAt: 1798000000,
      };
      const first = await createManualDispatch(client, TABLE_NAME, input);
      const second = await createManualDispatch(client, TABLE_NAME, input);
      expect(first.outcome).toBe('created');
      expect(second.outcome).toBe('duplicate');

      const rows = await client.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'pk = :pk',
          FilterExpression: 'payload.narrative = :narrative',
          ExpressionAttributeValues: { ':pk': `DEPT#${deptId}#OUTBOX`, ':narrative': narrative },
        }),
      );
      expect(rows.Items).toHaveLength(1);
      expect(rows.Items?.[0]?.correlationId).toBe(
        first.outcome === 'created' ? first.dispatchId : 'unreachable',
      );
    });
  });

  it('creates a DISPATCH_ALERT with sourceSystem MANUAL and sane tone-ladder defaults (AC2)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const externalId = `created-${randomUUID()}`;
    const idempotencyKey = deriveIngressIdempotencyKey(deptId, 'MANUAL', externalId);

    const result = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(externalId),
      idempotencyKey,
      dispatchedAt: 1798000000,
    });

    expect(result.outcome).toBe('created');
    const dispatchId = result.outcome === 'created' ? result.dispatchId : '';

    const item = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`, sk: 'METADATA' },
      }),
    );

    expect(item.Item).toMatchObject({
      entityType: 'DISPATCH_ALERT',
      sourceSystem: 'MANUAL',
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      unitsRequested: ['ENGINE-2'],
      toneLadderStatus: 'ACTIVE',
      currentToneSequence: 1,
    });
  });

  it('rejects a duplicate manual submission of the same operator-entered reference — exactly one DISPATCH_ALERT, not two (AC4, core-harm)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const externalId = `dup-${randomUUID()}`;
    const idempotencyKey = deriveIngressIdempotencyKey(deptId, 'MANUAL', externalId);
    const input = {
      deptId,
      dispatch: dispatchPayload(externalId),
      idempotencyKey,
      dispatchedAt: 1798000000,
    };

    const first = await createManualDispatch(client, TABLE_NAME, input);
    expect(first.outcome).toBe('created');

    const second = await createManualDispatch(client, TABLE_NAME, input);
    expect(second.outcome).toBe('duplicate');

    const scan = await client.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'entityType = :entityType AND idempotencyKey = :idempotencyKey',
        ExpressionAttributeValues: {
          ':entityType': 'DISPATCH_ALERT',
          ':idempotencyKey': idempotencyKey,
        },
      }),
    );
    expect(scan.Items).toHaveLength(1);
  });

  it('creates distinct DISPATCH_ALERT items for two different externalDispatchId submissions (survivor coverage)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const externalIdA = `survivor-a-${randomUUID()}`;
    const externalIdB = `survivor-b-${randomUUID()}`;

    const resultA = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(externalIdA),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'MANUAL', externalIdA),
      dispatchedAt: 1798000000,
    });
    const resultB = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(externalIdB),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'MANUAL', externalIdB),
      dispatchedAt: 1798000000,
    });

    expect(resultA.outcome).toBe('created');
    expect(resultB.outcome).toBe('created');
    const dispatchIdA = resultA.outcome === 'created' ? resultA.dispatchId : '';
    const dispatchIdB = resultB.outcome === 'created' ? resultB.dispatchId : '';
    expect(dispatchIdA).not.toBe('');
    expect(dispatchIdB).not.toBe('');
    expect(dispatchIdA).not.toBe(dispatchIdB);
  });

  it('a CAD submission and a MANUAL submission sharing one externalDispatchId both create an alert (P5 — idempotency key must include sourceSystem)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const sharedExternalId = `shared-${randomUUID()}`;

    const manualResult = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(sharedExternalId, 'MANUAL'),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'MANUAL', sharedExternalId),
      dispatchedAt: 1798000000,
    });
    const cadResult = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(sharedExternalId, 'CAD'),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'CAD', sharedExternalId),
      dispatchedAt: 1798000001,
    });

    expect(manualResult.outcome).toBe('created');
    expect(cadResult.outcome).toBe('created');
  });

  it('getDispatchById returns the stored alert by dispatchId (E1-S17 AC1 read path)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const externalId = `getbyid-${randomUUID()}`;
    const created = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(externalId),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'MANUAL', externalId),
      dispatchedAt: 1798000000,
    });
    const dispatchId = created.outcome === 'created' ? created.dispatchId : '';

    const found = await getDispatchById(client, TABLE_NAME, deptId, dispatchId);
    expect(found?.dispatchId).toBe(dispatchId);
  });

  it('getDispatchById returns occupancyId when present on the stored item (E1-S17 AC1)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = `occ-${randomUUID()}`;
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`,
          sk: 'METADATA',
          entityType: 'DISPATCH_ALERT',
          dispatchId,
          deptId,
          occupancyId: 'OCC-1',
        },
      }),
    );

    const found = await getDispatchById(client, TABLE_NAME, deptId, dispatchId);
    expect(found?.occupancyId).toBe('OCC-1');
  });

  it('getDispatchById returns undefined for a dispatchId that does not exist (E1-S17 AC2)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const found = await getDispatchById(client, TABLE_NAME, deptId, 'no-such-dispatch');
    expect(found).toBeUndefined();
  });

  it('mints a -SELFTEST- dispatchId and carries targetMemberId/selfTestId/channelsTested/isTest for a SELF_TEST submission, leaving MANUAL unaffected (E1-S8 AC1/AC3)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const testId = `selftest-${randomUUID()}`;

    const result = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(testId, 'SELF_TEST'),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'SELF_TEST', testId),
      dispatchedAt: 1798000000,
      targetMemberId: 'mbr-1',
      selfTestId: testId,
      channelsTested: ['PUSH', 'SMS'],
    });

    expect(result.outcome).toBe('created');
    const dispatchId = result.outcome === 'created' ? result.dispatchId : '';
    expect(dispatchId).toContain('-SELFTEST-');

    const item = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`, sk: 'METADATA' },
      }),
    );
    expect(item.Item).toMatchObject({
      entityType: 'DISPATCH_ALERT',
      sourceSystem: 'SELF_TEST',
      isTest: true,
      targetMemberId: 'mbr-1',
      selfTestId: testId,
      channelsTested: ['PUSH', 'SMS'],
    });
    expect(item.Item?.gsi2pk).toBeUndefined();
    expect(item.Item?.gsi2sk).toBeUndefined();
    expect(typeof item.Item?.ttl).toBe('number');

    const manualResult = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(`manual-${randomUUID()}`, 'MANUAL'),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'MANUAL', `manual-${randomUUID()}`),
      dispatchedAt: 1798000000,
    });
    expect(manualResult.outcome).toBe('created');
    const manualId = manualResult.outcome === 'created' ? manualResult.dispatchId : '';
    expect(manualId).toContain('-MANUAL-');
    const manualItem = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${deptId}#DISPATCH#${manualId}`, sk: 'METADATA' },
      }),
    );
    expect(manualItem.Item?.isTest).toBe(false);
    expect(manualItem.Item?.targetMemberId).toBeUndefined();
  });
});
