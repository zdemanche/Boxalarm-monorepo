import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

vi.mock('../eligibility/dynamoClient.js', () => ({
  createDynamoClient: vi.fn(),
  readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
}));

vi.mock('./snsClient.js', () => ({
  getSnsClient: vi.fn(() => ({})),
  readAlertingTopicConfig: vi.fn(() => ({
    topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
  })),
  publishEscalationTriggered: vi.fn().mockResolvedValue(undefined),
}));

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function createFakeDdb(seed: readonly FakeItem[]): {
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
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return Promise.resolve({ Item: items.get(`${key.pk}#${key.sk}`) });
    }
    if (name === 'TransactWriteCommand') {
      const transactItems = input.TransactItems as ReadonlyArray<Record<string, unknown>>;
      const failedIndex = transactItems.findIndex((txItem) => {
        const put = txItem.Put as { Item: FakeItem; ConditionExpression?: string } | undefined;
        return (
          put?.ConditionExpression === 'attribute_not_exists(idempotencyKey)' &&
          items.has(`${put.Item.pk}#${put.Item.sk}`)
        );
      });
      if (failedIndex !== -1) {
        const error = new Error('conditional check failed');
        error.name = 'TransactionCanceledException';
        (error as unknown as { CancellationReasons: { Code: string }[] }).CancellationReasons =
          transactItems.map((_, i) => ({
            Code: i === failedIndex ? 'ConditionalCheckFailed' : 'None',
          }));
        throw error;
      }
      for (const txItem of transactItems) {
        if (txItem.Put) {
          const put = txItem.Put as { Item: FakeItem };
          items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
        if (txItem.Update) {
          const update = txItem.Update as {
            Key: { pk: string; sk: string };
            ExpressionAttributeValues: Record<string, unknown>;
          };
          const key = `${update.Key.pk}#${update.Key.sk}`;
          const existing = items.get(key) ?? { pk: update.Key.pk, sk: update.Key.sk };
          items.set(key, {
            ...existing,
            currentChannelTier: update.ExpressionAttributeValues[':tier'],
            escalationLevel: update.ExpressionAttributeValues[':level'],
          });
        }
      }
      return Promise.resolve({});
    }
    throw new Error(`fake ddb: unsupported command ${name}`);
  });
  return { send: send, items };
}

const ROSTER_PK = 'DEPT#NICHOLS#DISPATCH#dispatch-1';

const BASE_PAYLOAD = {
  deptId: 'NICHOLS',
  dispatchId: 'dispatch-1',
  memberId: 'mbr-1',
  toneSequence: 1,
  channel: 'voice' as const,
};

describe('escalationHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:alerting-topic.fifo';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('AC1: escalates a never-acking member exactly once, recording ESCALATION_EVENT fromChannel/toChannel/reason (core-harm)', async () => {
    const fakeDdb = createFakeDdb([
      {
        pk: ROSTER_PK,
        sk: 'ROSTER#mbr-1',
        entityType: 'DISPATCH_ROSTER_ENTRY',
        memberId: 'mbr-1',
        ackStatus: 'NONE',
        currentChannelTier: 'primary',
      },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({
      send: fakeDdb.send,
    } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./escalationHandler.js');
    const result = await handler(BASE_PAYLOAD);

    expect(result).toEqual({ outcome: 'ESCALATED' });
    const escalationEvent = [...fakeDdb.items.values()].find(
      (item) => item.entityType === 'ESCALATION_EVENT',
    );
    expect(escalationEvent).toMatchObject({
      memberId: 'mbr-1',
      fromChannel: 'primary',
      toChannel: 'VOICE',
      reason: 'NO_ACK_TIMEOUT',
      toneSequence: 1,
    });

    const { publishEscalationTriggered } = await import('./snsClient.js');
    expect(publishEscalationTriggered).toHaveBeenCalledTimes(1);
  });

  it('AC3: writes a new RECEIPT#{memberId}#voice item and never overwrites the push/sms receipts', async () => {
    const pushReceipt = {
      pk: ROSTER_PK,
      sk: 'RECEIPT#mbr-1#PUSH#1',
      entityType: 'DELIVERY_RECEIPT',
      channel: 'PUSH',
      sentAt: 1798000003,
    };
    const smsReceipt = {
      pk: ROSTER_PK,
      sk: 'RECEIPT#mbr-1#SMS#1',
      entityType: 'DELIVERY_RECEIPT',
      channel: 'SMS',
      sentAt: 1798000003,
    };
    const fakeDdb = createFakeDdb([
      pushReceipt,
      smsReceipt,
      {
        pk: ROSTER_PK,
        sk: 'ROSTER#mbr-1',
        entityType: 'DISPATCH_ROSTER_ENTRY',
        memberId: 'mbr-1',
        ackStatus: 'NONE',
        currentChannelTier: 'primary',
      },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({
      send: fakeDdb.send,
    } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./escalationHandler.js');
    await handler(BASE_PAYLOAD);

    expect(fakeDdb.items.get(`${ROSTER_PK}#RECEIPT#mbr-1#PUSH#1`)).toEqual(pushReceipt);
    expect(fakeDdb.items.get(`${ROSTER_PK}#RECEIPT#mbr-1#SMS#1`)).toEqual(smsReceipt);
    const voiceReceipt = fakeDdb.items.get(`${ROSTER_PK}#RECEIPT#mbr-1#voice#1`);
    expect(voiceReceipt).toMatchObject({
      channel: 'voice',
      channelTier: 'escalation',
      idempotencyKey: 'dispatch-1#1#mbr-1#voice',
    });
    // The voice worker's own send guard lives under the uppercase key; the producer must not
    // pre-claim it or the worker duplicate-skips the call.
    expect(fakeDdb.items.has(`${ROSTER_PK}#RECEIPT#mbr-1#VOICE#1`)).toBe(false);
  });

  it('AC2: a member who has acked is skipped and no voice escalation is sent', async () => {
    const fakeDdb = createFakeDdb([
      {
        pk: ROSTER_PK,
        sk: 'ROSTER#mbr-1',
        entityType: 'DISPATCH_ROSTER_ENTRY',
        memberId: 'mbr-1',
        ackStatus: 'RESPONDING',
        currentChannelTier: 'primary',
      },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({
      send: fakeDdb.send,
    } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./escalationHandler.js');
    const result = await handler(BASE_PAYLOAD);

    expect(result).toEqual({ outcome: 'SKIPPED_ACKED' });
    expect(fakeDdb.items.has(`${ROSTER_PK}#RECEIPT#mbr-1#voice#1`)).toBe(false);
    const { publishEscalationTriggered } = await import('./snsClient.js');
    expect(publishEscalationTriggered).not.toHaveBeenCalled();
  });

  it('a roster row absent (fan-out gap) is skipped without throwing', async () => {
    const fakeDdb = createFakeDdb([]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({
      send: fakeDdb.send,
    } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./escalationHandler.js');
    const result = await handler(BASE_PAYLOAD);

    expect(result).toEqual({ outcome: 'SKIPPED_NOT_FOUND' });
  });

  it('an already-escalated member (conditional put collision) returns SKIPPED_ALREADY_ESCALATED, not a throw', async () => {
    const fakeDdb = createFakeDdb([
      {
        pk: ROSTER_PK,
        sk: 'ROSTER#mbr-1',
        entityType: 'DISPATCH_ROSTER_ENTRY',
        memberId: 'mbr-1',
        ackStatus: 'NONE',
        currentChannelTier: 'primary',
      },
      {
        pk: ROSTER_PK,
        sk: 'RECEIPT#mbr-1#voice#1',
        entityType: 'DELIVERY_RECEIPT',
        idempotencyKey: 'dispatch-1#1#mbr-1#voice',
      },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({
      send: fakeDdb.send,
    } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./escalationHandler.js');
    const result = await handler(BASE_PAYLOAD);

    expect(result).toEqual({ outcome: 'SKIPPED_ALREADY_ESCALATED' });
  });

  it('malformed payload throws malformed_payload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./escalationHandler.js');

    await expect(handler({ dispatchId: 'dispatch-1' })).rejects.toThrow(
      'escalation schedule payload failed shape validation',
    );
    await expect(handler(null)).rejects.toThrow(
      'escalation schedule payload failed shape validation',
    );
  });

  it('rethrows when DynamoDB is unavailable on the initial read (entrypoint, error-path logging)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error('table unreachable'));
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./escalationHandler.js');

    await expect(handler(BASE_PAYLOAD)).rejects.toThrow('table unreachable');
  });
});
