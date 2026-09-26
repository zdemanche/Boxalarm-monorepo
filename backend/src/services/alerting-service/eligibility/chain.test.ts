import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent } from '@boxalarm/authz';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function splitTopLevel(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of expression) {
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts;
}

function resolveAssignmentValue(
  existing: FakeItem,
  field: string,
  rhs: string,
  values: Record<string, unknown>,
): unknown {
  const ifNotExists = rhs.match(/^if_not_exists\(\s*\w+\s*,\s*(:\w+)\s*\)$/);
  if (ifNotExists?.[1]) {
    return existing[field] !== undefined ? existing[field] : values[ifNotExists[1]];
  }
  return values[rhs];
}

function applyUpdate(
  items: Map<string, FakeItem>,
  key: { pk: string; sk: string },
  updateExpression: string,
  values: Record<string, unknown>,
): void {
  const mapKey = `${key.pk}#${key.sk}`;
  const existing: FakeItem = items.get(mapKey) ?? { pk: key.pk, sk: key.sk };
  for (const assignment of splitTopLevel(updateExpression.replace(/^SET /, ''))) {
    const eqIndex = assignment.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const field = assignment.slice(0, eqIndex).trim();
    const rhs = assignment.slice(eqIndex + 1).trim();
    if (field && rhs) {
      existing[field] = resolveAssignmentValue(existing, field, rhs, values);
    }
  }
  items.set(mapKey, existing);
}

function pkPlaceholder(keyConditionExpression: string): string {
  return keyConditionExpression.match(/\bpk\s*=\s*(:\w+)/)?.[1] ?? ':pk';
}

function matchesSkPrefix(
  item: FakeItem,
  keyConditionExpression: string | undefined,
  values: Record<string, unknown>,
): boolean {
  const prefixPlaceholder = keyConditionExpression?.match(/begins_with\(sk,\s*(:\w+)\)/)?.[1];
  if (!prefixPlaceholder) {
    return true;
  }
  const prefix = values[prefixPlaceholder] as string;
  return typeof item.sk === 'string' && item.sk.startsWith(prefix);
}

function matchesFilterExpression(
  item: FakeItem,
  filterExpression: string | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!filterExpression) {
    return true;
  }
  return filterExpression.split(' AND ').every((clause) => {
    const clauseMatch = clause.trim().match(/^(\w+)\s*=\s*(:\w+)$/);
    if (!clauseMatch) {
      return true;
    }
    const [, field, valuePlaceholder] = clauseMatch;
    return field !== undefined && valuePlaceholder && item[field] === values[valuePlaceholder];
  });
}

function createFakeDdb(seed: readonly FakeItem[] = []): {
  send: DynamoDBDocumentClient['send'];
  items: Map<string, FakeItem>;
} {
  const items = new Map<string, FakeItem>();
  for (const item of seed) {
    items.set(`${item.pk}#${item.sk}`, item);
  }
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'TransactWriteCommand') {
      for (const txItem of input.TransactItems as ReadonlyArray<Record<string, unknown>>) {
        if (txItem.Put) {
          const put = txItem.Put as { Item: FakeItem };
          items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
        if (txItem.Update) {
          const update = txItem.Update as {
            Key: { pk: string; sk: string };
            UpdateExpression: string;
            ExpressionAttributeValues: Record<string, unknown>;
          };
          applyUpdate(items, update.Key, update.UpdateExpression, update.ExpressionAttributeValues);
        }
      }
      return {};
    }
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return { Item: items.get(`${key.pk}#${key.sk}`) };
    }
    if (name === 'PutCommand') {
      const put = input as { Item: FakeItem; ConditionExpression?: string };
      const mapKey = `${put.Item.pk}#${put.Item.sk}`;
      if (put.ConditionExpression === 'attribute_not_exists(pk)' && items.has(mapKey)) {
        throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
      }
      items.set(mapKey, put.Item);
      return {};
    }
    if (name === 'UpdateCommand') {
      const update = input as {
        Key: { pk: string; sk: string };
        UpdateExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
      applyUpdate(items, update.Key, update.UpdateExpression, update.ExpressionAttributeValues);
      return {};
    }
    if (name === 'QueryCommand') {
      const query = input as {
        ExpressionAttributeValues: Record<string, unknown>;
        KeyConditionExpression?: string;
        FilterExpression?: string;
      };
      const placeholder = pkPlaceholder(query.KeyConditionExpression ?? '');
      return {
        Items: [...items.values()].filter(
          (item) =>
            item.pk === query.ExpressionAttributeValues[placeholder] &&
            matchesSkPrefix(item, query.KeyConditionExpression, query.ExpressionAttributeValues) &&
            matchesFilterExpression(item, query.FilterExpression, query.ExpressionAttributeValues),
        ),
      };
    }
    throw new Error(`chain.test.ts fake ddb: unsupported command ${name}`);
  });
  return { send: send as unknown as DynamoDBDocumentClient['send'], items };
}

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const NOW = Math.floor(Date.now() / 1000);

describe('E2-S5 chain: markoff creation suppresses fan-out eligibility and reversion restores it (F2.5)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    process.env.AVAILABILITY_EXPIRY_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:expiry';
    process.env.AVAILABILITY_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../../personnel-service/availability/dynamoClient.js');
    vi.doUnmock('./dynamoClient.js');
  });

  it('drives handler -> outbox -> publisher -> consumer -> selector for a member marking off now, then expiryHandler -> outbox -> publisher -> consumer -> selector for reversion at window end', async () => {
    const personnel = createFakeDdb();
    const alerting = createFakeDdb([
      {
        pk: 'DEPT#NICHOLS#ELIGIBILITY',
        sk: 'MEMBER#mbr-1',
        entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
        memberId: 'mbr-1',
        active: true,
        quals: [],
        roles: [],
        availabilityState: 'AVAILABLE',
        snapshotUpdatedAt: NOW - 10_000,
      },
    ]);

    vi.doMock('../../personnel-service/availability/dynamoClient.js', async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import('../../personnel-service/availability/dynamoClient.js')
        >();
      return {
        ...actual,
        createDdbClient: () => ({ send: personnel.send }) as unknown as DynamoDBDocumentClient,
      };
    });
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () => ({ send: alerting.send }) as unknown as DynamoDBDocumentClient,
      };
    });

    const { createAvailability } = await import('../../personnel-service/availability/handler.js');
    const { handler: expiryHandler } =
      await import('../../personnel-service/availability/expiryHandler.js');
    const { handler: publish } = await import('../../personnel-service/outbox/publisher.js');
    const { handler: consume } = await import('./consumer.js');
    const { queryEligibleMembers } = await import('./selector.js');

    const startAt = NOW - 60;
    const endAt = NOW + 3600;
    const createEvent = {
      pathParameters: { memberId: 'mbr-1' },
      headers: {},
      body: JSON.stringify({ startAt, endAt, reason: 'Vacation' }),
    } as unknown as GuardEvent;

    const schedulerSend = vi.fn().mockResolvedValue({});
    const createResult = await createAvailability(
      createEvent,
      { sub: 'mbr-1', deptId: 'NICHOLS' },
      { schedulerClient: { send: schedulerSend } as unknown as SchedulerClient },
    );
    expect(createResult).toMatchObject({ statusCode: 201 });

    const outboxEntry = [...personnel.items.values()].find(
      (item) => item.entityType === 'OUTBOX_ENTRY',
    );
    expect(outboxEntry).toBeDefined();

    const publishedDetails: string[] = [];
    const ebSend = vi.fn((command: { input: { Entries: Array<{ Detail: string }> } }) => {
      for (const entry of command.input.Entries) {
        publishedDetails.push(entry.Detail);
      }
      return Promise.resolve({ Entries: command.input.Entries.map(() => ({})) });
    });

    const streamEvent = {
      Records: [
        {
          eventName: 'INSERT',
          dynamodb: {
            NewImage: {
              pk: { S: outboxEntry!.pk },
              sk: { S: outboxEntry!.sk },
              entityType: { S: 'OUTBOX_ENTRY' },
              eventId: { S: outboxEntry!.eventId as string },
              eventType: { S: 'personnel.availability.changed' },
              correlationId: { S: 'mbr-1' },
              createdAt: { N: String(outboxEntry!.createdAt) },
              payload: {
                M: {
                  deptId: { S: 'NICHOLS' },
                  memberId: { S: 'mbr-1' },
                  availabilityState: { S: 'MARKED_OFF' },
                },
              },
            },
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    await publish(streamEvent, {
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
    });
    expect(publishedDetails).toHaveLength(1);
    const markedOffEnvelope = JSON.parse(publishedDetails[0]!) as {
      eventId: string;
      eventTime: string;
    };
    expect(markedOffEnvelope).toMatchObject({
      eventType: 'personnel.availability.changed',
      source: 'personnel-service',
      correlationId: 'mbr-1',
      schemaVersion: '1.0',
    });
    expect(typeof markedOffEnvelope.eventId).toBe('string');
    expect(typeof markedOffEnvelope.eventTime).toBe('string');

    await consume({
      Records: [
        {
          messageId: 'm1',
          body: JSON.stringify({
            detail: JSON.parse(publishedDetails[0]!) as Record<string, unknown>,
          }),
        },
      ],
    } as unknown as SQSEvent);

    const eligibleWhileMarkedOff = await queryEligibleMembers(
      { send: alerting.send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    expect(eligibleWhileMarkedOff.map((m) => m.memberId)).not.toContain('mbr-1');

    const revertResult = await expiryHandler({
      deptId: 'NICHOLS',
      memberId: 'mbr-1',
      startAt,
      action: 'REVERT',
    });
    expect(revertResult).toEqual({ outcome: 'REVERTED' });

    const revertOutboxEntry = [...personnel.items.values()]
      .filter((item) => item.entityType === 'OUTBOX_ENTRY')
      .find(
        (item) => (item.payload as { availabilityState: string }).availabilityState === 'AVAILABLE',
      );
    expect(revertOutboxEntry).toBeDefined();

    const revertStreamEvent = {
      Records: [
        {
          eventName: 'INSERT',
          dynamodb: {
            NewImage: {
              pk: { S: revertOutboxEntry!.pk },
              sk: { S: revertOutboxEntry!.sk },
              entityType: { S: 'OUTBOX_ENTRY' },
              eventId: { S: revertOutboxEntry!.eventId as string },
              eventType: { S: 'personnel.availability.changed' },
              correlationId: { S: 'mbr-1' },
              createdAt: { N: String(revertOutboxEntry!.createdAt) },
              payload: {
                M: {
                  deptId: { S: 'NICHOLS' },
                  memberId: { S: 'mbr-1' },
                  availabilityState: { S: 'AVAILABLE' },
                },
              },
            },
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    await publish(revertStreamEvent, {
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
    });
    expect(publishedDetails).toHaveLength(2);

    await consume({
      Records: [
        {
          messageId: 'm2',
          body: JSON.stringify({
            detail: JSON.parse(publishedDetails[1]!) as Record<string, unknown>,
          }),
        },
      ],
    } as unknown as SQSEvent);

    const eligibleAfterRevert = await queryEligibleMembers(
      { send: alerting.send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    expect(eligibleAfterRevert.map((m) => m.memberId)).toContain('mbr-1');
  });
});

describe('E3-S8 chain: expired certification revokes qual currency and suppresses fan-out eligibility', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.TRAINING_DYNAMO_TABLE_NAME = 'shared-table';
    process.env.PERSONNEL_TABLE_NAME = 'shared-table';
    process.env.PLATFORM_TABLE_NAME = 'shared-table';
    process.env.PLATFORM_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../../personnel-service/availability/dynamoClient.js');
  });

  it('drives expireCertification -> certExpiredReactor -> outbox -> outboxPublisher -> eligibilityChangedConsumer -> selector exclusion (AC1-AC4)', async () => {
    const shared = createFakeDdb([
      {
        pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
        sk: 'CERT#CERT-0091',
        entityType: 'CERTIFICATION',
        certId: 'CERT-0091',
        memberId: 'mbr-1',
        status: 'CURRENT',
        expiryDate: '2026-01-01',
      },
      {
        pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
        sk: 'QUAL#INTERIOR',
        entityType: 'MEMBER_QUALIFICATION',
        qualCode: 'INTERIOR',
        grantedByCertId: 'CERT-0091',
        currentlyEligible: true,
      },
    ]);
    const alerting = createFakeDdb([
      {
        pk: 'DEPT#NICHOLS#ELIGIBILITY',
        sk: 'MEMBER#mbr-1',
        entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
        memberId: 'mbr-1',
        active: true,
        quals: ['INTERIOR'],
        roles: [],
        availabilityState: 'AVAILABLE',
        snapshotUpdatedAt: NOW - 10_000,
      },
    ]);

    const { createDynamoDocClient } = await import('../../personnel-service/awsClients.js');
    createDynamoDocClient({ send: shared.send } as unknown as DynamoDBDocumentClient);

    vi.doMock('../../personnel-service/availability/dynamoClient.js', async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import('../../personnel-service/availability/dynamoClient.js')
        >();
      return {
        ...actual,
        createDdbClient: () => ({ send: shared.send }) as unknown as DynamoDBDocumentClient,
      };
    });

    const { expireCertification } =
      await import('../../training-service/certificationRepository.js');
    const didFlip = await expireCertification(
      { send: shared.send } as unknown as DynamoDBDocumentClient,
      process.env,
      {
        deptId: DEPT_ID,
        memberId: 'mbr-1',
        certId: 'CERT-0091',
        correlationId: 'trace-e3s8',
        now: new Date('2026-09-14T12:00:00Z'),
      },
    );
    expect(didFlip).toBe(true);

    const certStreamEvent = {
      Records: [
        {
          eventID: 'seq-1',
          dynamodb: {
            SequenceNumber: 'seq-1',
            OldImage: marshall({
              pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
              sk: 'CERT#CERT-0091',
              entityType: 'CERTIFICATION',
              certId: 'CERT-0091',
              status: 'CURRENT',
            }),
            NewImage: marshall({
              pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
              sk: 'CERT#CERT-0091',
              entityType: 'CERTIFICATION',
              certId: 'CERT-0091',
              status: 'EXPIRED',
            }),
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    const { handler: reactorHandler } =
      await import('../../personnel-service/events/certExpiredReactor.js');
    const reactorResult = await reactorHandler(certStreamEvent, {} as never, () => undefined);
    expect(reactorResult).toEqual({ batchItemFailures: [] });

    const flippedQual = shared.items.get('DEPT#NICHOLS#MEMBER#mbr-1#QUAL#INTERIOR');
    expect(flippedQual?.currentlyEligible).toBe(false);

    const outboxItem = [...shared.items.values()].find(
      (item) => item.entityType === 'OUTBOX_ENTRY',
    );
    expect(outboxItem).toBeDefined();
    expect(outboxItem!.eventType).toBe('personnel.eligibility.changed');
    expect(outboxItem!.sentAt).toBeNull();

    const outboxStreamEvent = {
      Records: [
        {
          eventID: 'seq-2',
          eventName: 'INSERT',
          dynamodb: {
            SequenceNumber: 'seq-2',
            NewImage: marshall(outboxItem!),
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    const publishedDetails: string[] = [];
    const ebSend = vi.fn((command: { input: { Entries: Array<{ Detail: string }> } }) => {
      for (const entry of command.input.Entries) {
        publishedDetails.push(entry.Detail);
      }
      return Promise.resolve({
        Entries: command.input.Entries.map(() => ({})),
        FailedEntryCount: 0,
      });
    });

    const { handler: publisherHandler } =
      await import('../../personnel-service/outbox/publisher.js');
    await publisherHandler(outboxStreamEvent, {
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
    });
    expect(publishedDetails).toHaveLength(1);
    expect(JSON.parse(publishedDetails[0]!)).toMatchObject({
      eventType: 'personnel.eligibility.changed',
      payload: {
        deptId: 'NICHOLS',
        memberId: 'mbr-1',
        qualCode: 'INTERIOR',
        currentlyEligible: false,
        grantedByCertId: 'CERT-0091',
      },
    });

    const { createHandler: createConsumerHandler } =
      await import('./eligibilityChangedConsumer.js');
    const consumerHandler = createConsumerHandler({
      client: { send: alerting.send } as unknown as DynamoDBDocumentClient,
    });
    await consumerHandler(
      {
        Records: [
          {
            messageId: 'm1',
            body: JSON.stringify({
              detail: JSON.parse(publishedDetails[0]!) as Record<string, unknown>,
            }),
          },
        ],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const { queryEligiblePartition } = await import('./selector.js');
    const snapshot = await queryEligiblePartition(
      { send: alerting.send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    const memberSnapshot = snapshot.find((item) => item.memberId === 'mbr-1');
    expect(memberSnapshot?.quals).not.toContain('INTERIOR');
  });

  it('drives revokeCertification -> certExpiredReactor -> outbox -> outboxPublisher -> eligibilityChangedConsumer -> selector exclusion (AC5)', async () => {
    const shared = createFakeDdb([
      {
        pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
        sk: 'CERT#CERT-0091',
        entityType: 'CERTIFICATION',
        certId: 'CERT-0091',
        memberId: 'mbr-1',
        status: 'CURRENT',
        expiryDate: '2027-01-01',
      },
      {
        pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
        sk: 'QUAL#INTERIOR',
        entityType: 'MEMBER_QUALIFICATION',
        qualCode: 'INTERIOR',
        grantedByCertId: 'CERT-0091',
        currentlyEligible: true,
      },
    ]);
    const alerting = createFakeDdb([
      {
        pk: 'DEPT#NICHOLS#ELIGIBILITY',
        sk: 'MEMBER#mbr-1',
        entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
        memberId: 'mbr-1',
        active: true,
        quals: ['INTERIOR'],
        roles: [],
        availabilityState: 'AVAILABLE',
        snapshotUpdatedAt: NOW - 10_000,
      },
    ]);

    const { createDynamoDocClient } = await import('../../personnel-service/awsClients.js');
    createDynamoDocClient({ send: shared.send } as unknown as DynamoDBDocumentClient);

    vi.doMock('../../personnel-service/availability/dynamoClient.js', async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import('../../personnel-service/availability/dynamoClient.js')
        >();
      return {
        ...actual,
        createDdbClient: () => ({ send: shared.send }) as unknown as DynamoDBDocumentClient,
      };
    });

    const { revokeCertification } =
      await import('../../training-service/certificationRepository.js');
    const revoked = await revokeCertification(
      { send: shared.send } as unknown as DynamoDBDocumentClient,
      process.env,
      {
        deptId: DEPT_ID,
        memberId: 'mbr-1',
        certId: 'CERT-0091',
        actorId: 'OFFICER-1',
        correlationId: 'trace-e3s8-revoke',
        now: new Date('2026-09-14T12:00:00Z'),
      },
    );
    expect(revoked.status).toBe('REVOKED');

    const certStreamEvent = {
      Records: [
        {
          eventID: 'seq-1',
          dynamodb: {
            SequenceNumber: 'seq-1',
            OldImage: marshall({
              pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
              sk: 'CERT#CERT-0091',
              entityType: 'CERTIFICATION',
              certId: 'CERT-0091',
              status: 'CURRENT',
            }),
            NewImage: marshall({
              pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
              sk: 'CERT#CERT-0091',
              entityType: 'CERTIFICATION',
              certId: 'CERT-0091',
              status: 'REVOKED',
            }),
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    const { handler: reactorHandler } =
      await import('../../personnel-service/events/certExpiredReactor.js');
    const reactorResult = await reactorHandler(certStreamEvent, {} as never, () => undefined);
    expect(reactorResult).toEqual({ batchItemFailures: [] });

    const flippedQual = shared.items.get('DEPT#NICHOLS#MEMBER#mbr-1#QUAL#INTERIOR');
    expect(flippedQual?.currentlyEligible).toBe(false);

    const outboxItem = [...shared.items.values()].find(
      (item) => item.entityType === 'OUTBOX_ENTRY',
    );
    expect(outboxItem).toBeDefined();
    expect(outboxItem!.sentAt).toBeNull();

    const outboxStreamEvent = {
      Records: [
        {
          eventID: 'seq-2',
          eventName: 'INSERT',
          dynamodb: {
            SequenceNumber: 'seq-2',
            NewImage: marshall(outboxItem!),
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    const publishedDetails: string[] = [];
    const ebSend = vi.fn((command: { input: { Entries: Array<{ Detail: string }> } }) => {
      for (const entry of command.input.Entries) {
        publishedDetails.push(entry.Detail);
      }
      return Promise.resolve({
        Entries: command.input.Entries.map(() => ({})),
        FailedEntryCount: 0,
      });
    });

    const { handler: publisherHandler } =
      await import('../../personnel-service/outbox/publisher.js');
    await publisherHandler(outboxStreamEvent, {
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
    });
    expect(publishedDetails).toHaveLength(1);
    expect(JSON.parse(publishedDetails[0]!)).toMatchObject({
      eventType: 'personnel.eligibility.changed',
      payload: {
        deptId: 'NICHOLS',
        memberId: 'mbr-1',
        qualCode: 'INTERIOR',
        currentlyEligible: false,
        grantedByCertId: 'CERT-0091',
      },
    });

    const { createHandler: createConsumerHandler } =
      await import('./eligibilityChangedConsumer.js');
    const consumerHandler = createConsumerHandler({
      client: { send: alerting.send } as unknown as DynamoDBDocumentClient,
    });
    await consumerHandler(
      {
        Records: [
          {
            messageId: 'm1',
            body: JSON.stringify({
              detail: JSON.parse(publishedDetails[0]!) as Record<string, unknown>,
            }),
          },
        ],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const { queryEligiblePartition } = await import('./selector.js');
    const snapshot = await queryEligiblePartition(
      { send: alerting.send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    const memberSnapshot = snapshot.find((item) => item.memberId === 'mbr-1');
    expect(memberSnapshot?.quals).not.toContain('INTERIOR');
  });
});
