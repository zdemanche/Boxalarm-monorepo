import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/**
 * A real EventBridge->SQS body: the rule target has no inputPath, so SQS receives the whole
 * EventBridge event and the outbox envelope is under `detail`.
 */
function sqsEvent(payload: Record<string, unknown>, messageId = 'msg-1'): SQSEvent {
  return {
    Records: [
      {
        messageId,
        body: JSON.stringify({
          version: '0',
          id: 'eb-evt-1',
          'detail-type': 'personnel.availability.changed',
          source: 'personnel-service',
          account: '123456789012',
          time: '2026-09-06T00:00:00Z',
          region: 'us-east-1',
          resources: [],
          detail: {
            eventId: 'evt-1',
            eventTime: '2026-09-06T00:00:00Z',
            eventType: 'personnel.availability.changed',
            source: 'personnel-service',
            correlationId: 'mbr-1',
            schemaVersion: '1.0',
            payload,
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('./dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

describe('eligibility consumer (entrypoint-test obligation)', () => {
  it('sets availabilityState=MARKED_OFF and updates snapshotUpdatedAt on the MEMBER_ELIGIBILITY_SNAPSHOT (AC3)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./consumer.js');

    await handler(
      sqsEvent({ deptId: 'NICHOLS', memberId: 'mbr-1', availabilityState: 'MARKED_OFF' }),
    );

    const transactCall = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: Array<{
          Update?: {
            Key: Record<string, string>;
            ExpressionAttributeValues: Record<string, unknown>;
          };
        }>;
      };
    };
    const updateItem = transactCall.input.TransactItems.find((item) => item.Update)?.Update;
    expect(updateItem?.Key).toEqual({ pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-1' });
    expect(updateItem?.ExpressionAttributeValues[':state']).toBe('MARKED_OFF');
  });

  it('sets availabilityState=AVAILABLE when the window ends (AC4)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./consumer.js');

    await handler(
      sqsEvent({ deptId: 'NICHOLS', memberId: 'mbr-1', availabilityState: 'AVAILABLE' }),
    );

    const transactCall = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: Array<{ Update?: { ExpressionAttributeValues: Record<string, unknown> } }>;
      };
    };
    const updateItem = transactCall.input.TransactItems.find((item) => item.Update)?.Update;
    expect(updateItem?.ExpressionAttributeValues[':state']).toBe('AVAILABLE');
  });

  it('no-ops on a duplicate eventId (dedup hit) without touching the snapshot', async () => {
    const dedupConflict = Object.assign(new Error('dup'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockRejectedValueOnce(dedupConflict);
    mockDdb(send);
    const { handler } = await import('./consumer.js');

    await handler(
      sqsEvent({ deptId: 'NICHOLS', memberId: 'mbr-1', availabilityState: 'MARKED_OFF' }),
    );

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('scopes the dedup partition key by member, not just consumer name, so concurrent members do not collide on one partition', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./consumer.js');

    await handler(
      sqsEvent({ deptId: 'NICHOLS', memberId: 'mbr-7', availabilityState: 'MARKED_OFF' }),
    );

    const transactCall = send.mock.calls[0]?.[0] as {
      input: { TransactItems: { Put: { Item: Record<string, unknown> } }[] };
    };
    const dedupItem = transactCall.input.TransactItems[0]?.Put.Item;
    expect(dedupItem?.pk).toBe('DEPT#NICHOLS#DEDUP#eligibility-consumer#mbr-7');
  });

  it('rethrows on a malformed/absent payload field, never silently dropping the message', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./consumer.js');

    await expect(handler(sqsEvent({ deptId: 'NICHOLS' }))).rejects.toThrow(
      'personnel.availability.changed event failed shape validation',
    );
    expect(send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('rejects a bare envelope with no EventBridge `detail` wrapper (never what the rule delivers)', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./consumer.js');
    const bare = {
      Records: [
        {
          messageId: 'msg-bare',
          body: JSON.stringify({
            eventId: 'evt-1',
            eventTime: '2026-09-06T00:00:00Z',
            payload: { deptId: 'NICHOLS', memberId: 'mbr-1', availabilityState: 'MARKED_OFF' },
          }),
        },
      ],
    } as unknown as SQSEvent;

    await expect(handler(bare)).rejects.toThrow('missing detail');
    expect(send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('emits SnapshotPropagationLatencyMs with the elapsed ms from eventTime to now (AC5)', async () => {
    vi.setSystemTime(new Date('2026-09-06T00:00:05.000Z'));
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./consumer.js');

    await handler(
      sqsEvent({ deptId: 'NICHOLS', memberId: 'mbr-1', availabilityState: 'MARKED_OFF' }),
    );

    const emitted = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.SnapshotPropagationLatencyMs !== undefined);
    expect(emitted?.SnapshotPropagationLatencyMs).toBe(5000);
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it('clamps a future eventTime (clock skew) to 0 and logs a warning instead of throwing', async () => {
    vi.setSystemTime(new Date('2026-09-05T23:59:00.000Z'));
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./consumer.js');

    await handler(
      sqsEvent({ deptId: 'NICHOLS', memberId: 'mbr-1', availabilityState: 'MARKED_OFF' }),
    );

    const emitted = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.SnapshotPropagationLatencyMs !== undefined);
    expect(emitted?.SnapshotPropagationLatencyMs).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('eligibility.snapshot_propagation_future_event_time'),
    );
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('never reads from or calls personnel-service — writes only to this dept eligibility snapshot key (C-2 isolation)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./consumer.js');

    await handler(
      sqsEvent({ deptId: 'NICHOLS', memberId: 'mbr-1', availabilityState: 'MARKED_OFF' }),
    );

    for (const call of send.mock.calls) {
      const input = (call[0] as { input: unknown }).input;
      expect(JSON.stringify(input)).not.toContain('platform-table');
    }
  });
});
