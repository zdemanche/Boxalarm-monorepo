import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { DeliverChannelMessageParams } from './deliverChannelMessage.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeDdb(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function mockAdapter(sendViaHttpProvider: ReturnType<typeof vi.fn>): void {
  vi.doMock('./httpProviderAdapter.js', () => ({ sendViaHttpProvider }));
}

const baseParams: DeliverChannelMessageParams = {
  deptId,
  dispatchId: 'dispatch-1',
  memberId: 'mbr-1',
  channel: 'push',
  toneSequence: 1,
  contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }],
  message: 'structure-fire — 12 Main St',
  env: {},
};

afterEach(() => {
  vi.resetModules();
});

describe('deliverChannelMessage', () => {
  it('writes an immutable DELIVERY_RECEIPT keyed by dispatch/member/channel/tone, then sends via the adapter', async () => {
    const send = vi.fn().mockResolvedValue({});
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(send).toHaveBeenCalledTimes(1);
    const putInput = (send.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } })
      .input;
    expect(putInput.Item.pk).toBe('DEPT#NICHOLS#DISPATCH#dispatch-1');
    expect(putInput.Item.sk).toBe('RECEIPT#mbr-1#PUSH#1');
    expect(putInput.Item.idempotencyKey).toBe('dispatch-1#1#mbr-1#PUSH');
    expect(putInput.Item.gsi1pk).toBe('MEMBER#mbr-1');
    expect(putInput.Item.sentAt).toBeLessThan(10_000_000_000);
    expect(putInput.Item.gsi1sk).toBe(`RECEIPT#${putInput.Item.sentAt as number}#dispatch-1`);
    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'push',
      'tok-1',
      baseParams.message,
      baseParams.env,
      { isTest: false },
    );
  });

  it('no-ops without calling the provider when the idempotency key already exists for a prior successful attempt (duplicate skip)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'PutCommand') {
        return Promise.reject(
          new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
        );
      }
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { failureReason: null, deliveredAt: null } });
      }
      return Promise.resolve({});
    });
    const sendViaHttpProvider = vi.fn();
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('skips without a put when no target is registered for the channel', async () => {
    const send = vi.fn();
    const sendViaHttpProvider = vi.fn();
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', {
      ...baseParams,
      contactChannels: [],
    });

    expect(send).not.toHaveBeenCalled();
    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('logs the original error, records failureReason on the claimed receipt, and rethrows when the provider adapter throws (no swallow, DLQ redrive takes over)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UpdateCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const sendViaHttpProvider = vi.fn().mockRejectedValue(new Error('push provider down'));
    mockAdapter(sendViaHttpProvider);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('push provider down');

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
    const updateInput = (
      updateCall?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input;
    expect(updateInput.ExpressionAttributeValues[':reason']).toBe('push provider down');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('emits SendFailed under the Reason=<channel> dimension the infra delivery-failure alarm watches', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockAdapter(vi.fn().mockRejectedValue(new Error('push provider down')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('push provider down');

    // infrastructure/components/alerting/alarms.ts alarms on
    // Boxalarm/AlertingChannel SendFailed with dimensions { Reason: channel }.
    const emf = logSpy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((entry) => entry !== undefined && 'SendFailed' in entry) as
      | {
          _aws: { CloudWatchMetrics: { Namespace: string; Dimensions: string[][] }[] };
          Reason: string;
        }
      | undefined;
    expect(emf).toBeDefined();
    expect(emf!._aws.CloudWatchMetrics[0]!.Namespace).toBe('Boxalarm/AlertingChannel');
    expect(emf!._aws.CloudWatchMetrics[0]!.Dimensions).toContainEqual(['Reason']);
    expect(emf!.Reason).toBe('push');
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('re-attempts the send on redelivery when the prior claim failed and was never delivered (P8 regression)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'PutCommand') {
        return Promise.reject(
          new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
        );
      }
      if (name === 'GetCommand') {
        return Promise.resolve({
          Item: { failureReason: 'push provider down', deliveredAt: null },
        });
      }
      return Promise.resolve({});
    });
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'push',
      'tok-1',
      baseParams.message,
      baseParams.env,
      { isTest: false },
    );
    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
  });

  it('logs the original error and rethrows when the receipt write itself fails for a non-duplicate reason', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    const sendViaHttpProvider = vi.fn();
    mockAdapter(sendViaHttpProvider);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('DynamoDB unavailable');

    expect(sendViaHttpProvider).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
