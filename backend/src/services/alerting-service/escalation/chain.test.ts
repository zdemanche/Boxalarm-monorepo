import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { SNSClient } from '@aws-sdk/client-sns';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function applyUpdate(
  items: Map<string, FakeItem>,
  key: { pk: string; sk: string },
  updateExpression: string,
  values: Record<string, unknown>,
): void {
  const mapKey = `${key.pk}#${key.sk}`;
  const existing: FakeItem = items.get(mapKey) ?? { pk: key.pk, sk: key.sk };
  for (const assignment of updateExpression.replace(/^SET /, '').split(',')) {
    const [field, valueRef] = assignment.split('=').map((part) => part.trim());
    if (field && valueRef) {
      existing[field] = values[valueRef];
    }
  }
  items.set(mapKey, existing);
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
            UpdateExpression: string;
            ExpressionAttributeValues: Record<string, unknown>;
          };
          applyUpdate(items, update.Key, update.UpdateExpression, update.ExpressionAttributeValues);
        }
      }
      return Promise.resolve({});
    }
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return Promise.resolve({ Item: items.get(`${key.pk}#${key.sk}`) });
    }
    if (name === 'QueryCommand') {
      const query = input as { ExpressionAttributeValues: Record<string, string> };
      return Promise.resolve({
        Items: [...items.values()].filter(
          (item) => item.pk === query.ExpressionAttributeValues[':pk'],
        ),
      });
    }
    throw new Error(`escalation/chain.test.ts fake ddb: unsupported command ${name}`);
  });
  return { send: send, items };
}

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('E1-S3 chain: fan-out -> schedule -> escalation-fired handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:alerting-topic.fifo';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('escalates a non-acking member exactly once and leaves an acked member alone (AC1/AC2/AC3/AC5)', async () => {
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
        snapshotUpdatedAt: 0,
      },
      {
        pk: 'DEPT#NICHOLS#ELIGIBILITY',
        sk: 'MEMBER#mbr-2',
        entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
        memberId: 'mbr-2',
        active: true,
        quals: [],
        roles: [],
        availabilityState: 'AVAILABLE',
        snapshotUpdatedAt: 0,
      },
    ]);

    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () => ({ send: alerting.send }) as unknown as DynamoDBDocumentClient,
      };
    });

    const schedulerSend = vi.fn().mockResolvedValue({});
    const snsSend = vi.fn().mockResolvedValue({});
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return {
        ...actual,
        getSnsClient: () => ({ send: snsSend }) as unknown as SNSClient,
      };
    });

    const { runFanOut } = await import('../fanout/fanOut.js');
    const { handler: escalationHandler } = await import('./escalationHandler.js');

    await runFanOut(
      { send: alerting.send } as unknown as DynamoDBDocumentClient,
      { send: schedulerSend } as unknown as SchedulerClient,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      1798000000,
    );

    expect(schedulerSend).toHaveBeenCalledTimes(2);
    const pushBefore = alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#push#1');
    const smsBefore = alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#sms#1');
    expect(pushBefore).toBeDefined();
    expect(smsBefore).toBeDefined();

    alerting.items.set('DEPT#NICHOLS#DISPATCH#dispatch-1#ROSTER#mbr-2', {
      ...alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#ROSTER#mbr-2')!,
      ackStatus: 'RESPONDING',
    });

    const escalatedResult = await escalationHandler({
      deptId: 'NICHOLS',
      dispatchId: 'dispatch-1',
      memberId: 'mbr-1',
      toneSequence: 1,
      channel: 'voice',
    });
    const ackedResult = await escalationHandler({
      deptId: 'NICHOLS',
      dispatchId: 'dispatch-1',
      memberId: 'mbr-2',
      toneSequence: 1,
      channel: 'voice',
    });

    expect(escalatedResult).toEqual({ outcome: 'ESCALATED' });
    expect(ackedResult).toEqual({ outcome: 'SKIPPED_ACKED' });

    expect(alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#push#1')).toEqual(
      pushBefore,
    );
    expect(alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#sms#1')).toEqual(
      smsBefore,
    );
    expect(
      alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#voice#1'),
    ).toBeDefined();
    expect(alerting.items.has('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-2#voice#1')).toBe(
      false,
    );

    expect(snsSend).toHaveBeenCalledTimes(1);
  });
});
