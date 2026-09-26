import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
  process.env.PUSH_PROVIDER_ENDPOINT_URL = 'https://push.example';
  process.env.PUSH_PROVIDER_SECRET_ID = 'push-secret';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function sqsEvent(channel: string, memberId = 'mbr-1', isTest = false): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          eventId: 'evt-1',
          eventTime: '2026-09-06T00:00:00Z',
          eventType: 'alerting.dispatch.normalized',
          source: 'alert-fanout-service',
          correlationId: 'dispatch-1',
          schemaVersion: '1.0',
          payload: {
            deptId: 'NICHOLS',
            dispatchId: 'dispatch-1',
            memberId,
            channel,
            channelTier: 'primary',
            toneSequence: 1,
            isTest,
            incidentType: 'structure-fire',
            address: '12 Main St',
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function mockDeps(
  sendViaHttpProvider: ReturnType<typeof vi.fn>,
  send: ReturnType<typeof vi.fn>,
): void {
  vi.doMock('../httpProviderAdapter.js', () => ({ sendViaHttpProvider }));
  vi.doMock('../../eligibility/dynamoClient.js', () => ({
    createDynamoClient: () => ({ send }),
    readAlertingConfig: () => ({ tableName: 'alerting-table' }),
  }));
}

describe('push channel worker (entrypoint-test obligation)', () => {
  it('reports a malformed record as a batch item failure and never calls the provider', async () => {
    const sendViaHttpProvider = vi.fn();
    const send = vi.fn();
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    const result = await handler({
      Records: [{ messageId: 'msg-1', body: 'not-json' }],
    } as unknown as SQSEvent);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('reports only the poisoned record as a batch item failure in a mixed batch, leaving the valid record delivered', async () => {
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: { contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }] },
        });
      }
      return Promise.resolve({});
    });
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    const goodEvent = sqsEvent('push');
    const mixedEvent: SQSEvent = {
      Records: [{ messageId: 'msg-poison', body: 'not-json' }, ...goodEvent.Records],
    } as unknown as SQSEvent;

    const result = await handler(mixedEvent);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-poison' }]);
    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'push',
      'tok-1',
      'structure-fire — 12 Main St',
      process.env,
      { isTest: false },
    );
  });

  it('sends a self-test/canary message (isTest=true, as fan-out stamps it) with the sandbox credentials', async () => {
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: { contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }] },
        });
      }
      return Promise.resolve({});
    });
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('push', 'mbr-1', true));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'push',
      'tok-1',
      'structure-fire — 12 Main St',
      process.env,
      { isTest: true },
    );
  });

  it('reports a batch item failure for an envelope routed to this worker carrying a different channel', async () => {
    const sendViaHttpProvider = vi.fn();
    const send = vi.fn();
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('sms'));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('resolves the target from the eligibility snapshot and sends via the push provider on the happy path', async () => {
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: { contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }] },
        });
      }
      return Promise.resolve({});
    });
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('push'));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'push',
      'tok-1',
      'structure-fire — 12 Main St',
      process.env,
      { isTest: false },
    );
  });

  it('logs a structured entry with correlationId/memberId/channel and reports a batch item failure when the eligibility read fails', async () => {
    const sendViaHttpProvider = vi.fn();
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.reject(new Error('DynamoDB throttled'));
      }
      return Promise.resolve({});
    });
    mockDeps(sendViaHttpProvider, send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('push'));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
    expect(sendViaHttpProvider).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('alerting.channel.eligibility_read_failed'),
    );
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.correlationId).toBe('dispatch-1');
    expect(logged.memberId).toBe('mbr-1');
    expect(logged.channel).toBe('push');
    errorSpy.mockRestore();
  });
});
