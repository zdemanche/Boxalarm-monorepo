import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

/**
 * A real EventBridge→SQS body: the rule target has no inputPath, so SQS receives the whole
 * EventBridge event and the outbox drainer's envelope (drainHandler.ts `Detail`) is under `detail`.
 */
function buildSqsEvent(envelope: unknown): SQSEvent {
  const eventBridgeEvent = {
    version: '0',
    id: '6a7e8feb-b491-4cf7-a9f1-bf3703467718',
    'detail-type': 'personnel.member.updated',
    source: 'personnel-service',
    account: '123456789012',
    time: '2026-09-14T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: envelope,
  };
  return { Records: [{ body: JSON.stringify(eventBridgeEvent) }] } as unknown as SQSEvent;
}

const VALID_ENVELOPE = {
  eventId: 'evt-1',
  eventTime: '2026-09-14T00:00:00.000Z',
  eventType: 'personnel.member.updated',
  source: 'personnel-service',
  correlationId: 'mbr-102',
  schemaVersion: '1.0',
  payload: {
    deptId: 'NICHOLS',
    memberId: 'mbr-102',
    active: true,
    contactChannels: [{ channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true }],
  },
};

describe('memberUpdatedHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('./dynamoClient.js');
  });

  it('throws (never swallows) when the payload is missing memberId, so SQS retries/DLQs (AC-matrix)', async () => {
    const send = vi.fn();
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await expect(
      handler(
        buildSqsEvent({
          ...VALID_ENVELOPE,
          payload: { ...VALID_ENVELOPE.payload, memberId: undefined },
        }),
      ),
    ).rejects.toThrow('memberId');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a bare envelope with no EventBridge `detail` wrapper (never what the rule delivers)', async () => {
    const send = vi.fn();
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    const bare = { Records: [{ body: JSON.stringify(VALID_ENVELOPE) }] } as unknown as SQSEvent;
    await expect(handler(bare)).rejects.toThrow('missing detail');
    expect(send).not.toHaveBeenCalled();
  });

  it('upserts MEMBER_ELIGIBILITY_SNAPSHOT with contactChannels denormalized from the event payload (AC1, AC2)', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    const result = await handler(buildSqsEvent(VALID_ENVELOPE));

    expect(result).toEqual({ batchItemFailures: [] });
    const updateCall = send.mock.calls[0]?.[0] as {
      input: {
        Key: { pk: string; sk: string };
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(updateCall.input.Key).toEqual({ pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-102' });
    expect(updateCall.input.ExpressionAttributeValues[':contactChannels']).toEqual(
      VALID_ENVELOPE.payload.contactChannels,
    );
  });

  it('propagates an empty contactChannels array (AC5 revoke) into the snapshot', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      buildSqsEvent({
        ...VALID_ENVELOPE,
        payload: { deptId: 'NICHOLS', memberId: 'mbr-102', active: false, contactChannels: [] },
      }),
    );

    const updateCall = send.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(updateCall.input.ExpressionAttributeValues[':contactChannels']).toEqual([]);
    expect(updateCall.input.ExpressionAttributeValues[':active']).toBe(false);
  });

  it('a register-only event (no quals/roles/availabilityState) does not clear those fields (P6 regression)', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      buildSqsEvent({
        ...VALID_ENVELOPE,
        payload: {
          deptId: 'NICHOLS',
          memberId: 'mbr-102',
          contactChannels: [{ channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true }],
        },
      }),
    );

    const updateCall = send.mock.calls[0]?.[0] as {
      input: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(updateCall.input.UpdateExpression).not.toContain('quals');
    expect(updateCall.input.UpdateExpression).not.toContain('roles');
    expect(updateCall.input.UpdateExpression).not.toContain('active');
    expect(updateCall.input.ExpressionAttributeValues[':quals']).toBeUndefined();
    expect(updateCall.input.ExpressionAttributeValues[':active']).toBeUndefined();
  });

  it('a status->ACTIVE event with no contactChannels field does not clear the stored contactChannels (P7 regression)', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      buildSqsEvent({
        ...VALID_ENVELOPE,
        payload: { deptId: 'NICHOLS', memberId: 'mbr-102', status: 'ACTIVE', active: true },
      }),
    );

    const updateCall = send.mock.calls[0]?.[0] as {
      input: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(updateCall.input.UpdateExpression).not.toContain('contactChannels');
    expect(updateCall.input.ExpressionAttributeValues[':contactChannels']).toBeUndefined();
    expect(updateCall.input.ExpressionAttributeValues[':active']).toBe(true);
  });

  it('discards a stale/redelivered event (ConditionalCheckFailedException) without throwing (last-writer-wins)', async () => {
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const send = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'stale', $metadata: {} }));
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    const result = await handler(buildSqsEvent(VALID_ENVELOPE));
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('emits SnapshotPropagationLatencyMs with the elapsed ms from eventTime to now (AC5)', async () => {
    vi.setSystemTime(new Date('2026-09-14T00:00:07.000Z'));
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./memberUpdatedHandler.js');

    await handler(buildSqsEvent(VALID_ENVELOPE));

    const emitted = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.SnapshotPropagationLatencyMs !== undefined);
    expect(emitted?.SnapshotPropagationLatencyMs).toBe(7000);
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it('clamps a future eventTime (clock skew) to 0 and logs a warning instead of throwing', async () => {
    vi.setSystemTime(new Date('2026-09-13T23:59:00.000Z'));
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { handler } = await import('./memberUpdatedHandler.js');

    const result = await handler(buildSqsEvent(VALID_ENVELOPE));

    expect(result).toEqual({ batchItemFailures: [] });
    const emitted = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.SnapshotPropagationLatencyMs !== undefined);
    expect(emitted?.SnapshotPropagationLatencyMs).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('future_event_time'));
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('rethrows a non-conditional DynamoDB failure (never swallows) so SQS retries/DLQs', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await expect(handler(buildSqsEvent(VALID_ENVELOPE))).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    );
  });
});
