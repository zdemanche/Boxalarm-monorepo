import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
  process.env.VOICE_PROVIDER_ENDPOINT_URL = 'https://voice.example';
  process.env.VOICE_PROVIDER_SECRET_ID = 'voice-secret';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function sqsEvent(channel: string, memberId = 'mbr-1'): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          eventId: 'evt-1',
          eventTime: '2026-09-06T00:00:00Z',
          eventType: 'alerting.escalation.triggered',
          source: 'escalation-scheduler',
          correlationId: 'dispatch-1',
          schemaVersion: '1.0',
          payload: {
            deptId: 'NICHOLS',
            dispatchId: 'dispatch-1',
            memberId,
            channel,
            channelTier: 'escalation',
            toneSequence: 1,
            incidentType: 'structure-fire',
            address: '12 Main St',
            reason: 'no_ack_at_tier',
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

describe('voice channel worker (entrypoint-test obligation)', () => {
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

  it('reports a batch item failure for an envelope routed to this worker carrying a different channel', async () => {
    const sendViaHttpProvider = vi.fn();
    const send = vi.fn();
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('sms'));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('resolves the target from the eligibility snapshot and sends via the voice provider on the happy path', async () => {
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: {
            contactChannels: [{ channel: 'VOICE', phoneNumber: '+12035550100', valid: true }],
          },
        });
      }
      return Promise.resolve({});
    });
    mockDeps(sendViaHttpProvider, send);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('voice'));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'voice',
      '+12035550100',
      'structure-fire — 12 Main St',
      process.env,
      { isTest: false },
    );
  });
});
