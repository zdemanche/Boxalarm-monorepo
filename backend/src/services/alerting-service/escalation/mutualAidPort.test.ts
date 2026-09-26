import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SNSClient } from '@aws-sdk/client-sns';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { requestMutualAid } from './mutualAidPort.js';

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function createFakeDdb(
  seed: readonly FakeItem[],
  options: {
    readonly failPromptForMemberId?: string;
    readonly failOutboxWrite?: boolean;
  } = {},
): {
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
    if (name === 'QueryCommand') {
      const query = input as { ExpressionAttributeValues: Record<string, unknown> };
      const pk = query.ExpressionAttributeValues[':pk'];
      return Promise.resolve({ Items: [...items.values()].filter((item) => item.pk === pk) });
    }
    if (name === 'PutCommand') {
      const put = input as { Item: FakeItem; ConditionExpression?: string };
      const key = `${put.Item.pk}#${put.Item.sk}`;
      if (
        options.failPromptForMemberId &&
        put.Item.entityType === 'MUTUAL_AID_PROMPT' &&
        put.Item.memberId === options.failPromptForMemberId
      ) {
        throw new Error('ddb unavailable');
      }
      if (options.failOutboxWrite && put.Item.entityType === 'OUTBOX_ENTRY') {
        throw new Error('ddb unavailable');
      }
      if (put.ConditionExpression && items.has(key)) {
        const error = new Error('conditional check failed');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      items.set(key, put.Item);
      return Promise.resolve({});
    }
    if (name === 'TransactWriteCommand') {
      const transactItems = input.TransactItems as ReadonlyArray<Record<string, unknown>>;
      const failedIndex = transactItems.findIndex((txItem) => {
        const put = txItem.Put as { Item: FakeItem; ConditionExpression?: string } | undefined;
        return (
          put?.ConditionExpression === 'attribute_not_exists(pk)' &&
          items.has(`${put.Item.pk}#${put.Item.sk}`)
        );
      });
      if (failedIndex !== -1) {
        const error = new Error('conditional check failed');
        error.name = 'TransactionCanceledException';
        throw error;
      }
      for (const txItem of transactItems) {
        if (txItem.Put) {
          const put = txItem.Put as { Item: FakeItem };
          items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
      }
      return Promise.resolve({});
    }
    throw new Error(`fake ddb: unsupported command ${name}`);
  });
  return { send, items };
}

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const DISPATCH_TEXT = { incidentType: 'STRUCTURE_FIRE', address: '1 Main St', isTest: false };
const ELIGIBILITY_PK = 'DEPT#NICHOLS#ELIGIBILITY';

describe('requestMutualAid', () => {
  it('records the mutual-aid event once and prompts every eligible officer', async () => {
    const officer: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#officer-1',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'officer-1',
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const nonOfficer: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#mbr-1',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'mbr-1',
      active: true,
      quals: [],
      roles: [],
      contactChannels: [],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send, items } = createFakeDdb([officer, nonOfficer]);
    const snsSend = vi.fn().mockResolvedValue({});
    const sns = { send: snsSend } as unknown as SNSClient;

    const result = await requestMutualAid({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET',
    });

    expect(result).toEqual({
      requested: true,
      officersNotified: 1,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
    });
    expect(items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#MUTUALAID#SINGLETON')).toMatchObject({
      entityType: 'MUTUAL_AID_EVENT',
      reason: 'TONE_3_PREDICATE_UNMET',
    });
    expect(items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#MAPROMPT#officer-1#PUSH')).toBeDefined();
    expect(items.has('DEPT#NICHOLS#DISPATCH#dispatch-1#MAPROMPT#mbr-1#PUSH')).toBe(false);
    expect(snsSend).toHaveBeenCalledTimes(1);

    const outboxEntry = [...items.values()].find((item) => item.entityType === 'OUTBOX_ENTRY');
    expect(outboxEntry).toMatchObject({
      eventType: 'alerting.mutual_aid.triggered',
      source: 'alerting-service',
      payload: {
        dispatchId: 'dispatch-1',
        reason: 'TONE_3_PREDICATE_UNMET',
        adapterUsed: 'OFFICER_MANUAL_PROMPT',
        officersNotified: 1,
      },
    });
  });

  it('still reports success when the bridge outbox write fails (must never block or fail mutual aid)', async () => {
    const officer: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#officer-1',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'officer-1',
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send } = createFakeDdb([officer], { failOutboxWrite: true });
    const snsSend = vi.fn().mockResolvedValue({});
    const sns = { send: snsSend } as unknown as SNSClient;

    const result = await requestMutualAid({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET',
    });

    expect(result).toEqual({
      requested: true,
      officersNotified: 1,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
    });
  });

  it('still notifies every other officer when one officer prompt fails (MAJOR #2 regression)', async () => {
    const officerOk: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#officer-ok',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'officer-ok',
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const officerFail: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#officer-fail',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'officer-fail',
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send } = createFakeDdb([officerOk, officerFail], {
      failPromptForMemberId: 'officer-fail',
    });
    const snsSend = vi.fn().mockResolvedValue({});
    const sns = { send: snsSend } as unknown as SNSClient;

    const result = await requestMutualAid({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET',
    });

    // Does not throw for the whole batch, and the surviving officer is still counted.
    expect(result).toEqual({
      requested: true,
      officersNotified: 1,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
    });
  });

  it('is a no-op the second time it is invoked for the same dispatch (singleton guard)', async () => {
    const existingEvent: FakeItem = {
      pk: 'DEPT#NICHOLS#DISPATCH#dispatch-1',
      sk: 'MUTUALAID#SINGLETON',
      entityType: 'MUTUAL_AID_EVENT',
      reason: 'TONE_3_PREDICATE_UNMET',
    };
    const { send } = createFakeDdb([existingEvent]);
    const snsSend = vi.fn();
    const sns = { send: snsSend } as unknown as SNSClient;

    const result = await requestMutualAid({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET',
    });

    expect(result).toEqual({
      requested: false,
      officersNotified: 0,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
    });
    expect(snsSend).not.toHaveBeenCalled();
  });
});
