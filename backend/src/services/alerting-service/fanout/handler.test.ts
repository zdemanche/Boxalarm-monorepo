import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { DynamoDBStreamEvent } from 'aws-lambda';

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function createFakeDdb(
  seed: readonly FakeItem[] = [],
  options: { failPut?: (item: FakeItem) => boolean; trackConcurrency?: boolean } = {},
): {
  send: DynamoDBDocumentClient['send'];
  items: Map<string, FakeItem>;
  getMaxInFlightWrites: () => number;
} {
  const items = new Map<string, FakeItem>();
  for (const item of seed) {
    items.set(`${item.pk}#${item.sk}`, item);
  }
  let inFlightWrites = 0;
  let maxInFlightWrites = 0;
  const send = vi.fn(async (command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'TransactWriteCommand') {
      inFlightWrites += 1;
      maxInFlightWrites = Math.max(maxInFlightWrites, inFlightWrites);
      if (options.trackConcurrency) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      try {
        const txItems = input.TransactItems as ReadonlyArray<{
          Put?: { Item: FakeItem; ConditionExpression?: string };
        }>;
        for (const txItem of txItems) {
          if (txItem.Put) {
            const key = `${txItem.Put.Item.pk}#${txItem.Put.Item.sk}`;
            if (options.failPut?.(txItem.Put.Item)) {
              throw new Error('ddb write failed');
            }
            if (txItem.Put.ConditionExpression === 'attribute_not_exists(idempotencyKey)') {
              const existing = items.get(key);
              if (existing) {
                const error = Object.assign(new Error('duplicate'), {
                  name: 'TransactionCanceledException',
                  CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
                });
                throw error;
              }
            }
            items.set(key, txItem.Put.Item);
          }
        }
        return {};
      } finally {
        inFlightWrites -= 1;
      }
    }
    if (name === 'GetCommand') {
      const { Key } = input as { Key: { pk: string; sk: string } };
      return { Item: items.get(`${Key.pk}#${Key.sk}`) };
    }
    if (name === 'UpdateCommand') {
      const { Key, UpdateExpression, ExpressionAttributeValues } = input as {
        Key: { pk: string; sk: string };
        UpdateExpression: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
      const key = `${Key.pk}#${Key.sk}`;
      const existing: FakeItem = items.get(key) ?? { pk: Key.pk, sk: Key.sk };
      const setMatch = /SET (.+?)(?: REMOVE|$)/.exec(UpdateExpression);
      if (setMatch) {
        for (const assignment of setMatch[1]!.split(',')) {
          const [field, placeholder] = assignment.split('=').map((part) => part.trim());
          if (field && placeholder) {
            existing[field] = ExpressionAttributeValues?.[placeholder];
          }
        }
      }
      const removeMatch = /REMOVE (.+)$/.exec(UpdateExpression);
      if (removeMatch) {
        for (const field of removeMatch[1]!.split(',').map((part) => part.trim())) {
          delete existing[field];
        }
      }
      items.set(key, existing);
      return {};
    }
    if (name === 'PutCommand') {
      const { Item, ConditionExpression } = input as {
        Item: FakeItem;
        ConditionExpression?: string;
      };
      const key = `${Item.pk}#${Item.sk}`;
      if (ConditionExpression === 'attribute_not_exists(pk)' && items.has(key)) {
        const error = new Error('conditional check failed');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      items.set(key, Item);
      return {};
    }
    if (name === 'QueryCommand') {
      const query = input as { ExpressionAttributeValues: Record<string, string> };
      return {
        Items: [...items.values()].filter(
          (item) => item.pk === query.ExpressionAttributeValues[':pk'],
        ),
      };
    }
    throw new Error(`handler.test.ts fake ddb: unsupported command ${name}`);
  });
  return {
    send: send as DynamoDBDocumentClient['send'],
    items,
    getMaxInFlightWrites: () => maxInFlightWrites,
  };
}

interface FakeSnsCall {
  readonly TopicArn: string;
  readonly MessageGroupId: string;
  readonly MessageDeduplicationId: string;
  readonly MessageAttributes: Record<string, { DataType: string; StringValue: string }>;
}

function createFakeSns(failOn?: (call: FakeSnsCall) => boolean): {
  send: SNSClient['send'];
  calls: FakeSnsCall[];
} {
  const calls: FakeSnsCall[] = [];
  const send = vi.fn((command: unknown) => {
    const input = (command as { input: FakeSnsCall }).input;
    calls.push(input);
    if (failOn?.(input)) {
      return Promise.reject(new Error('SNS unavailable'));
    }
    return Promise.resolve({ MessageId: 'msg-1' });
  });
  return { send: send as SNSClient['send'], calls };
}

function createFakeScheduler(options: { failCreate?: (name: string) => Error | undefined } = {}): {
  send: SchedulerClient['send'];
  createdNames: string[];
  attemptedNames: string[];
} {
  const createdNames: string[] = [];
  const attemptedNames: string[] = [];
  const send = vi.fn((command: unknown) => {
    const ctorName = (command as { constructor: { name: string } }).constructor.name;
    if (ctorName !== 'CreateScheduleCommand') {
      throw new Error(`handler.test.ts fake scheduler: unsupported command ${ctorName}`);
    }
    const { Name, GroupName } = (command as { input: { Name: string; GroupName?: string } }).input;
    attemptedNames.push(Name);
    // Mirrors the IAM grant: scheduler:CreateSchedule is scoped to the dedicated group
    // only, so a schedule without GroupName (the implicit `default` group) is denied.
    if (GroupName !== 'boxalarm-dev-alerting-escalation') {
      const denied = new Error(
        `not authorized to create schedule in group ${GroupName ?? 'default'}`,
      );
      denied.name = 'AccessDeniedException';
      return Promise.reject(denied);
    }
    const failure = options.failCreate?.(Name);
    if (failure) {
      return Promise.reject(failure);
    }
    if (createdNames.includes(Name)) {
      const error = new Error('schedule already exists');
      error.name = 'ConflictException';
      return Promise.reject(error);
    }
    createdNames.push(Name);
    return Promise.resolve({});
  });
  return { send: send as SchedulerClient['send'], createdNames, attemptedNames };
}

function memberSnapshot(overrides: Record<string, unknown> = {}): FakeItem {
  const memberId = typeof overrides.memberId === 'string' ? overrides.memberId : 'mbr-1';
  return {
    pk: 'DEPT#NICHOLS#ELIGIBILITY',
    sk: `MEMBER#${memberId}`,
    entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
    memberId: 'mbr-1',
    active: true,
    quals: [],
    roles: [],
    contactChannels: [
      { channel: 'PUSH', token: 'tok-1', platform: 'APNS', valid: true },
      { channel: 'sms', token: '+15551234567' },
    ],
    availabilityState: 'AVAILABLE',
    snapshotUpdatedAt: 1000,
    ...overrides,
  };
}

function dispatchAlertInsertEvent(dispatchId = 'NICHOLS-1-1798000000'): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventName: 'INSERT',
        eventID: 'ev-1',
        dynamodb: {
          SequenceNumber: 'seq-1',
          NewImage: {
            pk: { S: `DEPT#NICHOLS#DISPATCH#${dispatchId}` },
            sk: { S: 'METADATA' },
            entityType: { S: 'DISPATCH_ALERT' },
            dispatchId: { S: dispatchId },
            deptId: { S: 'NICHOLS' },
            incidentType: { S: 'STRUCTURE_FIRE' },
            address: { S: '123 Main St' },
            crossStreets: { S: 'Main & Elm' },
            narrative: { S: 'Smoke showing' },
            mapLink: { S: 'https://maps.example/1' },
          },
        },
      },
    ],
  } as unknown as DynamoDBStreamEvent;
}

function selfTestDispatchInsertEvent(
  overrides: { dispatchId?: string; targetMemberId?: string; selfTestId?: string } = {},
): DynamoDBStreamEvent {
  const dispatchId = overrides.dispatchId ?? 'NICHOLS-SELFTEST-1798000000';
  const targetMemberId = overrides.targetMemberId ?? 'mbr-1';
  const selfTestId = overrides.selfTestId ?? '1798000000';
  return {
    Records: [
      {
        eventName: 'INSERT',
        eventID: 'ev-selftest-1',
        dynamodb: {
          SequenceNumber: 'seq-selftest-1',
          NewImage: {
            pk: { S: `DEPT#NICHOLS#DISPATCH#${dispatchId}` },
            sk: { S: 'METADATA' },
            entityType: { S: 'DISPATCH_ALERT' },
            dispatchId: { S: dispatchId },
            deptId: { S: 'NICHOLS' },
            incidentType: { S: 'SELF_TEST' },
            narrative: { S: 'Synthetic self-test dispatch' },
            isTest: { BOOL: true },
            sourceSystem: { S: 'SELF_TEST' },
            targetMemberId: { S: targetMemberId },
            selfTestId: { S: selfTestId },
            channelsTested: { L: [{ S: 'PUSH' }, { S: 'SMS' }] },
          },
        },
      },
    ],
  } as unknown as DynamoDBStreamEvent;
}

describe('fanout/handler self-test branch (E1-S8 AC1/AC2/AC3/AC4/AC5)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting-topic.fifo';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('addresses SNS/DELIVERY_RECEIPT only to targetMemberId even when the roster has other members, and records a PASS SELF_TEST_RUN (AC1/AC3/AC4, core-harm)', async () => {
    const ddb = createFakeDdb([
      memberSnapshot({ memberId: 'mbr-1' }),
      memberSnapshot({ memberId: 'mbr-2' }),
    ]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    const beforeMs = Date.now();
    await handler(selfTestDispatchInsertEvent());
    const afterMs = Date.now();

    expect(sns.calls).toHaveLength(2);
    const receipts = [...ddb.items.values()].filter(
      (item) => item.entityType === 'DELIVERY_RECEIPT',
    );
    expect(receipts).toHaveLength(2);
    expect(receipts.every((item) => item.memberId === 'mbr-1')).toBe(true);

    const run = ddb.items.get('DEPT#NICHOLS#MEMBER#mbr-1#SELFTEST#1798000000');
    expect(run?.entityType).toBe('SELF_TEST_RUN');
    expect(run?.overallResult).toBe('PASS');
    // The canary measures its latency against this completion stamp (canary/handler.ts).
    expect(run?.completedAtMs).toBeGreaterThanOrEqual(beforeMs);
    expect(run?.completedAtMs).toBeLessThanOrEqual(afterMs);
    const channelResults = run?.channelResults as Record<string, { ok: boolean; ms: number }>;
    expect(channelResults.PUSH?.ok).toBe(true);
    expect(channelResults.SMS?.ok).toBe(true);
  });

  it('records a specific push failure reason and overallResult FAIL when the member has no registered push token (AC5)', async () => {
    const ddb = createFakeDdb([
      memberSnapshot({
        memberId: 'mbr-1',
        contactChannels: [{ channel: 'sms', token: '+15551234567' }],
      }),
    ]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await handler(selfTestDispatchInsertEvent());

    const run = ddb.items.get('DEPT#NICHOLS#MEMBER#mbr-1#SELFTEST#1798000000');
    expect(run?.overallResult).toBe('FAIL');
    const channelResults = run?.channelResults as Record<string, { ok: boolean; reason?: string }>;
    expect(channelResults.PUSH).toEqual({ ok: false, ms: 0, reason: 'push: no token registered' });
    expect(channelResults.SMS?.ok).toBe(true);
  });

  it('records overallResult FAIL with reason "member not found" and never publishes when the targeted member has no MEMBER_ELIGIBILITY_SNAPSHOT, without failing the batch', async () => {
    const ddb = createFakeDdb([]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await expect(handler(selfTestDispatchInsertEvent())).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(sns.calls).toHaveLength(0);
    const run = ddb.items.get('DEPT#NICHOLS#MEMBER#mbr-1#SELFTEST#1798000000');
    expect(run?.overallResult).toBe('FAIL');
    const channelResults = run?.channelResults as Record<string, { ok: boolean; reason?: string }>;
    expect(channelResults.PUSH?.reason).toBe('member not found');
    expect(channelResults.SMS?.reason).toBe('member not found');
  });

  it('captures an SNS publish failure into channelResults with a specific reason instead of failing the batch (AC5, self-test never retries via Streams redrive)', async () => {
    const ddb = createFakeDdb([memberSnapshot({ memberId: 'mbr-1' })]);
    const sns = createFakeSns((call) => call.MessageAttributes.channel?.StringValue === 'push');
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await expect(handler(selfTestDispatchInsertEvent())).resolves.toEqual({
      batchItemFailures: [],
    });

    const run = ddb.items.get('DEPT#NICHOLS#MEMBER#mbr-1#SELFTEST#1798000000');
    expect(run?.overallResult).toBe('FAIL');
    const channelResults = run?.channelResults as Record<string, { ok: boolean; reason?: string }>;
    expect(channelResults.PUSH?.ok).toBe(false);
    expect(channelResults.PUSH?.reason).toContain('send failed');
    expect(channelResults.SMS?.ok).toBe(true);
  });

  it('records a specific SMS failure reason and overallResult FAIL when the member has no registered SMS number (P5)', async () => {
    const ddb = createFakeDdb([
      memberSnapshot({
        memberId: 'mbr-1',
        contactChannels: [{ channel: 'PUSH', token: 'tok-1', platform: 'APNS', valid: true }],
      }),
    ]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await handler(selfTestDispatchInsertEvent());

    const run = ddb.items.get('DEPT#NICHOLS#MEMBER#mbr-1#SELFTEST#1798000000');
    expect(run?.overallResult).toBe('FAIL');
    const channelResults = run?.channelResults as Record<string, { ok: boolean; reason?: string }>;
    expect(channelResults.SMS).toEqual({ ok: false, ms: 0, reason: 'sms: no number registered' });
    expect(channelResults.PUSH?.ok).toBe(true);
    expect(sns.calls).toHaveLength(1);
  });

  it('reports overallResult FAIL with an eligibility reason for a MARKED_OFF member even though both channels send successfully (P6)', async () => {
    const ddb = createFakeDdb([
      memberSnapshot({ memberId: 'mbr-1', availabilityState: 'MARKED_OFF' }),
    ]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await handler(selfTestDispatchInsertEvent());

    expect(sns.calls).toHaveLength(2);
    const run = ddb.items.get('DEPT#NICHOLS#MEMBER#mbr-1#SELFTEST#1798000000');
    expect(run?.overallResult).toBe('FAIL');
    expect(run?.eligibilityReason).toBe(
      'member is MARKED_OFF — a real dispatch would not page you',
    );
    const channelResults = run?.channelResults as Record<string, { ok: boolean }>;
    expect(channelResults.PUSH?.ok).toBe(true);
    expect(channelResults.SMS?.ok).toBe(true);
  });

  it('writes self-test DISPATCH_ALERT and DELIVERY_RECEIPT items without gsi2pk/gsi1pk so synthetic runs never surface in dept dispatch history or member receipt history (P7)', async () => {
    const ddb = createFakeDdb([memberSnapshot({ memberId: 'mbr-1' })]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await handler(selfTestDispatchInsertEvent());

    const receipts = [...ddb.items.values()].filter(
      (item) => item.entityType === 'DELIVERY_RECEIPT',
    );
    expect(receipts).toHaveLength(2);
    expect(receipts.every((item) => item.gsi1pk === undefined && item.gsi1sk === undefined)).toBe(
      true,
    );
    expect(receipts.every((item) => typeof item.ttl === 'number')).toBe(true);
  });
});

describe('fanout/handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting-topic.fifo';
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
    process.env.TONE_EVALUATOR_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:tone-evaluator';
    const defaultScheduler = createFakeScheduler();
    vi.doMock('../escalation/scheduleEscalation.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../escalation/scheduleEscalation.js')>();
      return {
        ...actual,
        getSchedulerClient: () => ({ send: defaultScheduler.send }) as unknown as SchedulerClient,
      };
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('exports a handler exercised by this test — one INSERT DISPATCH_ALERT record fans out (entrypoint test)', async () => {
    const ddb = createFakeDdb([memberSnapshot()]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await handler(dispatchAlertInsertEvent());

    expect(sns.calls).toHaveLength(2);
  });

  it('issues exactly one push publish and one SMS publish per eligible member — two distinct provider sends at T+0 (AC1, mandatory regression)', async () => {
    const ddb = createFakeDdb([memberSnapshot()]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await handler(dispatchAlertInsertEvent());

    const channels = sns.calls.map((call) => call.MessageAttributes.channel?.StringValue).sort();
    expect(channels).toEqual(['push', 'sms']);
    expect(sns.calls[0]!.MessageDeduplicationId).not.toBe(sns.calls[1]!.MessageDeduplicationId);
  });

  it('rejects a redelivered dispatch via the conditional put — exactly one receipt per member per channel, zero duplicate publishes (AC2)', async () => {
    const ddb = createFakeDdb([memberSnapshot()]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    const event = dispatchAlertInsertEvent();
    await handler(event);
    await handler(event);

    expect(sns.calls).toHaveLength(2);
    const receipts = [...ddb.items.values()].filter(
      (item) => item.entityType === 'DELIVERY_RECEIPT',
    );
    expect(receipts).toHaveLength(2);
  });

  it('keys the dedup guard on channel, never channelTier — a tier-keyed key would collapse push and sms into one item (AC3, core-harm)', async () => {
    const ddb = createFakeDdb([memberSnapshot()]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await handler(dispatchAlertInsertEvent());

    const receipts = [...ddb.items.values()].filter(
      (item) => item.entityType === 'DELIVERY_RECEIPT',
    );
    const keys = receipts.map((item) => item.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(receipts.map((item) => item.channel).sort()).toEqual(['push', 'sms']);
  });

  it('skips a non-INSERT or non-DISPATCH_ALERT record without throwing', async () => {
    const ddb = createFakeDdb();
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    const event = {
      Records: [
        { eventName: 'MODIFY', dynamodb: { NewImage: { entityType: { S: 'DISPATCH_ALERT' } } } },
        { eventName: 'INSERT', dynamodb: { NewImage: { entityType: { S: 'DELIVERY_RECEIPT' } } } },
      ],
    } as unknown as DynamoDBStreamEvent;

    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
    expect(sns.calls).toHaveLength(0);
  });

  it('emits zero publishes and does not throw for an empty eligible roster', async () => {
    const ddb = createFakeDdb([]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await expect(handler(dispatchAlertInsertEvent())).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(sns.calls).toHaveLength(0);
  });

  it('skips only the push send when the member has no registered push token — SMS is unaffected (E1-S14 dependency)', async () => {
    const ddb = createFakeDdb([
      memberSnapshot({ contactChannels: [{ channel: 'sms', token: '+15551234567' }] }),
    ]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await handler(dispatchAlertInsertEvent());

    expect(sns.calls).toHaveLength(1);
    expect(sns.calls[0]!.MessageAttributes.channel?.StringValue).toBe('sms');
  });

  it('reports the failing record as a batch item failure when one channel publish fails, without aborting the whole invocation — Streams redrives only that record (R3, no shard-blocking)', async () => {
    const ddb = createFakeDdb([memberSnapshot()]);
    const sns = createFakeSns((call) => call.MessageAttributes.channel?.StringValue === 'push');
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await expect(handler(dispatchAlertInsertEvent())).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-1' }],
    });

    expect(sns.calls).toHaveLength(2);
  });

  it('holds no import of the platform-service or incident-service tables anywhere in fanout/*.ts (AC4 isolation)', () => {
    const files = ['handler.ts', 'idempotencyKey.ts', 'snsClient.ts'];
    for (const file of files) {
      const path = fileURLToPath(new URL(file, import.meta.url));
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/platform-service/);
      expect(source).not.toMatch(/incident-service/);
    }
  });

  it('reports a batch item failure and emits ReceiptWriteFailed when the DELIVERY_RECEIPT write fails for a non-duplicate reason, without aborting the invocation (P5 regression)', async () => {
    const ddb = createFakeDdb([memberSnapshot()], {
      failPut: (item) => item.channel === 'push',
    });
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await expect(handler(dispatchAlertInsertEvent())).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-1' }],
    });

    expect(sns.calls).toHaveLength(1);
    expect(sns.calls[0]!.MessageAttributes.channel?.StringValue).toBe('sms');
  });

  it('reports a batch item failure for Streams redrive when a DISPATCH_ALERT record is missing dispatchId or deptId, without aborting other records in the batch (P6/R3 regression)', async () => {
    const ddb = createFakeDdb();
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    const event = {
      Records: [
        {
          eventName: 'INSERT',
          eventID: 'ev-malformed',
          dynamodb: {
            SequenceNumber: 'seq-malformed',
            NewImage: {
              entityType: { S: 'DISPATCH_ALERT' },
              deptId: { S: 'NICHOLS' },
            },
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    await expect(handler(event)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-malformed' }],
    });
    expect(sns.calls).toHaveLength(0);
  });

  it('re-publishes only the channel whose SNS publish failed on retry, and never double-publishes the channel that already succeeded (P7 exactly-once regression)', async () => {
    const ddb = createFakeDdb([memberSnapshot()]);
    let failPush = true;
    const sns = createFakeSns(
      (call) => failPush && call.MessageAttributes.channel?.StringValue === 'push',
    );
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    const event = dispatchAlertInsertEvent();
    await expect(handler(event)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-1' }],
    });
    expect(sns.calls).toHaveLength(2);

    failPush = false;
    await handler(event);

    expect(sns.calls).toHaveLength(3);
    const pushCalls = sns.calls.filter(
      (call) => call.MessageAttributes.channel?.StringValue === 'push',
    );
    const smsCalls = sns.calls.filter(
      (call) => call.MessageAttributes.channel?.StringValue === 'sms',
    );
    expect(pushCalls).toHaveLength(2);
    expect(smsCalls).toHaveLength(1);

    const receipts = [...ddb.items.values()].filter(
      (item) => item.entityType === 'DELIVERY_RECEIPT',
    );
    expect(receipts).toHaveLength(2);
    expect(receipts.every((item) => typeof item.sentAt === 'number')).toBe(true);
  });

  it('records sentAt only after the publish succeeds, and leaves failureReason (no sentAt) when the publish fails (P8 audit-evidence regression)', async () => {
    const ddb = createFakeDdb([memberSnapshot()]);
    const sns = createFakeSns((call) => call.MessageAttributes.channel?.StringValue === 'push');
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await expect(handler(dispatchAlertInsertEvent())).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-1' }],
    });

    const receipts = [...ddb.items.values()].filter(
      (item) => item.entityType === 'DELIVERY_RECEIPT',
    );
    const pushReceipt = receipts.find((item) => item.channel === 'push');
    const smsReceipt = receipts.find((item) => item.channel === 'sms');
    expect(pushReceipt?.sentAt).toBeUndefined();
    expect(pushReceipt?.failureReason).toBe('Error');
    expect(smsReceipt?.sentAt).toEqual(expect.any(Number));
    expect(smsReceipt?.failureReason).toBeUndefined();
  });

  it('emits a fan-out latency metric and records fanOutStartedAt/eligibleMemberCount on the DISPATCH_ALERT METADATA item (N1.1 SLO observability, P9 regression)', async () => {
    const ddb = createFakeDdb([memberSnapshot()]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');
    const dispatchId = 'NICHOLS-1-1798000000';
    await handler(dispatchAlertInsertEvent(dispatchId));
    const emitted = logSpy.mock.calls.map(
      ([line]) => JSON.parse(line as string) as Record<string, unknown>,
    );
    logSpy.mockRestore();

    const latencyMetric = emitted.find((entry) => entry.FanOutLatencyMs !== undefined);
    expect(latencyMetric).toBeDefined();
    expect(typeof latencyMetric?.FanOutLatencyMs).toBe('number');

    const metadata = ddb.items.get(`DEPT#NICHOLS#DISPATCH#${dispatchId}#METADATA`);
    expect(typeof metadata?.fanOutStartedAt).toBe('number');
    expect(metadata?.eligibleMemberCount).toBe(1);
  });

  it('carries isTest through to the normalized envelope and the SNS MessageAttributes so a self-test/canary dispatch never reaches real channels unmarked (P10 regression)', async () => {
    const ddb = createFakeDdb([memberSnapshot()]);
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    const event = dispatchAlertInsertEvent();
    const newImage = event.Records[0]!.dynamodb!.NewImage as unknown as Record<string, unknown>;
    newImage.isTest = { BOOL: true };
    newImage.sourceSystem = { S: 'SELF_TEST' };
    await handler(event);

    expect(sns.calls.every((call) => call.MessageAttributes.isTest?.StringValue === 'true')).toBe(
      true,
    );
    const receipts = [...ddb.items.values()].filter(
      (item) => item.entityType === 'DELIVERY_RECEIPT',
    );
    expect(receipts.every((item) => item.isTest === true)).toBe(true);
  });

  it('bounds fan-out concurrency instead of firing every member×channel task at once (P1 regression)', async () => {
    const members = Array.from({ length: 12 }, (_, index) =>
      memberSnapshot({ memberId: `mbr-${index}` }),
    );
    const ddb = createFakeDdb(members, { trackConcurrency: true });
    const sns = createFakeSns();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });

    const { handler } = await import('./handler.js');
    await handler(dispatchAlertInsertEvent());

    expect(sns.calls).toHaveLength(24);
    expect(ddb.getMaxInFlightWrites()).toBeGreaterThan(1);
    expect(ddb.getMaxInFlightWrites()).toBeLessThanOrEqual(10);
  });

  it('schedules tone-1 escalation and the department tone ladder exactly once per member/tone even when the stream record is redelivered (idempotent scheduling)', async () => {
    const ddb = createFakeDdb([memberSnapshot({ memberId: 'mbr-1' })]);
    const sns = createFakeSns();
    const scheduler = createFakeScheduler();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });
    vi.doMock('../escalation/scheduleEscalation.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../escalation/scheduleEscalation.js')>();
      return {
        ...actual,
        getSchedulerClient: () => ({ send: scheduler.send }) as unknown as SchedulerClient,
      };
    });

    const { handler } = await import('./handler.js');
    const event = dispatchAlertInsertEvent();

    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

    expect(new Set(scheduler.attemptedNames)).toEqual(
      new Set([
        'esc-NICHOLS-NICHOLS-1-1798000000-mbr-1-1',
        'tone-NICHOLS-NICHOLS-1-1798000000-2',
        'tone-NICHOLS-NICHOLS-1-1798000000-3',
      ]),
    );
    expect(scheduler.attemptedNames).toHaveLength(6);
    expect(scheduler.createdNames).toHaveLength(3);
    expect(sns.calls).toHaveLength(2);

    const roster = ddb.items.get('DEPT#NICHOLS#DISPATCH#NICHOLS-1-1798000000#ROSTER#mbr-1');
    expect(roster?.entityType).toBe('DISPATCH_ROSTER_ENTRY');
    expect(roster?.ackStatus).toBe('NONE');
  });

  it('still sends both tone-1 channel publishes when the escalation schedule create fails, then fails the batch item so Streams retries (core-harm, not silently swallowed)', async () => {
    const ddb = createFakeDdb([memberSnapshot({ memberId: 'mbr-1' })]);
    const sns = createFakeSns();
    const scheduler = createFakeScheduler({
      failCreate: (name) =>
        name.startsWith('esc-') ? new Error('scheduler unavailable') : undefined,
    });
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ddb as unknown as DynamoDBDocumentClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => sns as unknown as SNSClient };
    });
    vi.doMock('../escalation/scheduleEscalation.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../escalation/scheduleEscalation.js')>();
      return {
        ...actual,
        getSchedulerClient: () => ({ send: scheduler.send }) as unknown as SchedulerClient,
      };
    });

    const { handler } = await import('./handler.js');
    await expect(handler(dispatchAlertInsertEvent())).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-1' }],
    });

    expect(sns.calls).toHaveLength(2);
    const channels = sns.calls.map((call) => call.MessageAttributes.channel?.StringValue).sort();
    expect(channels).toEqual(['push', 'sms']);
  });
});
