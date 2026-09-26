import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';

type LambdaNewImage = NonNullable<NonNullable<DynamoDBRecord['dynamodb']>['NewImage']>;
type StreamHandler = (e: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>;

function fakeEventBridgeClient(send: (command: unknown) => Promise<unknown>): EventBridgeClient {
  return { send } as unknown as EventBridgeClient;
}

function fakeDdbClient(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function streamEvent(records: DynamoDBStreamEvent['Records']): DynamoDBStreamEvent {
  return { Records: records };
}

function newImage(item: Record<string, unknown>): LambdaNewImage {
  return marshall(item) as unknown as LambdaNewImage;
}

function outboxRecord(
  item: Record<string, unknown>,
  sequenceNumber: string,
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE' = 'INSERT',
): DynamoDBRecord {
  return {
    eventName,
    dynamodb: { NewImage: newImage(item), SequenceNumber: sequenceNumber },
  };
}

const OUTBOX_ITEM = {
  pk: 'DEPT#NICHOLS#OUTBOX',
  sk: 'EVENT#2026-09-14T00:00:00.000Z#evt-1',
  entityType: 'OUTBOX_ENTRY',
  eventId: 'evt-1',
  eventTime: '2026-09-14T00:00:00.000Z',
  eventType: 'inspections.preplan.updated',
  source: 'inspections-service',
  correlationId: 'PP-1',
  schemaVersion: '1.0',
  payload: { occupancyId: 'OCC-1', prePlanId: 'PP-1' },
  sentAt: null,
};

describe('createOutboxDrainHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.PLATFORM_TABLE_NAME = 'boxalarm-dev-platform';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('throws before any AWS call when PLATFORM_EVENT_BUS_NAME is not set (entrypoint test)', async () => {
    delete process.env.PLATFORM_EVENT_BUS_NAME;
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const handler = createOutboxDrainHandler('platform-service');
    await expect((handler as StreamHandler)(streamEvent([]))).rejects.toThrow(
      'PLATFORM_EVENT_BUS_NAME is required and was not set',
    );
  });

  it('throws before any AWS call when PLATFORM_TABLE_NAME is not set (entrypoint test)', async () => {
    delete process.env.PLATFORM_TABLE_NAME;
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const handler = createOutboxDrainHandler('platform-service');
    await expect((handler as StreamHandler)(streamEvent([]))).rejects.toThrow(
      'PLATFORM_TABLE_NAME is required and was not set',
    );
  });

  it('publishes an INSERT of an OUTBOX_ENTRY to EventBridge preserving source and eventType (AC4)', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
    const ddbSend = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(ddbSend),
    });
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
    const command = send.mock.calls[0]?.[0] as {
      input: { Entries: Array<Record<string, unknown>> };
    };
    const entry = command.input.Entries[0];
    expect(entry?.EventBusName).toBe('boxalarm-dev-platform-bus');
    expect(entry?.DetailType).toBe('inspections.preplan.updated');
    const detail = JSON.parse(entry?.Detail as string) as Record<string, unknown>;
    expect(detail.eventId).toBe('evt-1');
    expect(detail.correlationId).toBe('PP-1');
  });

  it('marks the outbox entry sent after a successful publish, conditioned on sentAt being unset', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
    const ddbSend = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(ddbSend),
    });
    await (handler as StreamHandler)(streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]));
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const command = ddbSend.mock.calls[0]?.[0] as {
      input: { Key: Record<string, string>; ConditionExpression: string };
    };
    expect(command.input.Key).toEqual({ pk: OUTBOX_ITEM.pk, sk: OUTBOX_ITEM.sk });
    expect(command.input.ConditionExpression).toBe(
      'attribute_not_exists(sentAt) OR sentAt = :null',
    );
  });

  it('does not fail the batch when the mark-sent update loses the race (already sent)', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
    const conditionalCheckError = Object.assign(new Error('conditional check failed'), {
      name: 'ConditionalCheckFailedException',
    });
    const ddbSend = vi.fn().mockRejectedValue(conditionalCheckError);
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(ddbSend),
    });
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]),
    );
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('does not retry an already-published event when marking sent fails for another reason', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
    const ddbSend = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(ddbSend),
    });
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]),
    );
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('skips a stream record whose entityType is not OUTBOX_ENTRY, publishing nothing', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(vi.fn()),
    });
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord({ entityType: 'PRE_PLAN' }, 'seq-1')]),
    );
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('skips a MODIFY/REMOVE record even when it carries an OUTBOX_ENTRY image', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(vi.fn()),
    });
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1', 'MODIFY')]),
    );
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('reports batchItemFailures instead of rejecting on EventBridge PutEvents failure, so only the failing chunk onward retries (core-harm)', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi.fn().mockRejectedValue(new Error('EventBridge unavailable'));
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(vi.fn()),
    });
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-1' }] });
  });

  it('reports batchItemFailures, and skips marking sent, for an entry PutEvents rejects individually', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi.fn().mockResolvedValue({
      Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'Rate exceeded' }],
    });
    const ddbSend = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(ddbSend),
    });
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-1' }] });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it('batches more than 10 outbox records into multiple PutEvents calls of at most 10 entries', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi
      .fn()
      .mockResolvedValue({ Entries: Array.from({ length: 10 }, () => ({ EventId: 'e' })) });
    const ddbSend = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(ddbSend),
    });
    const records = Array.from({ length: 12 }, (_, i) =>
      outboxRecord(
        {
          ...OUTBOX_ITEM,
          eventId: `evt-${i}`,
          sk: `EVENT#2026-09-14T00:00:00.000Z#evt-${i}`,
          correlationId: `PP-${i}`,
        },
        `seq-${i}`,
      ),
    );
    const result = await (handler as StreamHandler)(streamEvent(records));
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ batchItemFailures: [] });
    const firstCall = send.mock.calls[0]?.[0] as { input: { Entries: unknown[] } };
    const secondCall = send.mock.calls[1]?.[0] as { input: { Entries: unknown[] } };
    expect(firstCall.input.Entries).toHaveLength(10);
    expect(secondCall.input.Entries).toHaveLength(2);
  });

  it('does not retry a chunk that already succeeded when a later chunk fails (mixed-batch partial failure)', async () => {
    const { createOutboxDrainHandler } = await import('./drainHandler.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Entries: Array.from({ length: 10 }, () => ({ EventId: 'e' })) })
      .mockRejectedValueOnce(new Error('EventBridge unavailable'));
    const ddbSend = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: fakeEventBridgeClient(send),
      ddbClient: fakeDdbClient(ddbSend),
    });
    const records = Array.from({ length: 12 }, (_, i) =>
      outboxRecord(
        {
          ...OUTBOX_ITEM,
          eventId: `evt-${i}`,
          sk: `EVENT#2026-09-14T00:00:00.000Z#evt-${i}`,
          correlationId: `PP-${i}`,
        },
        `seq-${i}`,
      ),
    );
    const result = await (handler as StreamHandler)(streamEvent(records));
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-10' }] });
  });

  describe('options', () => {
    it('reads the table name from options.tableNameEnvVar and marks sent on that table', async () => {
      delete process.env.PLATFORM_TABLE_NAME;
      process.env.ALERTING_TABLE_NAME = 'boxalarm-dev-alerting-table';
      const { createOutboxDrainHandler } = await import('./drainHandler.js');
      const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
      const ddbSend = vi.fn().mockResolvedValue({});
      const handler = createOutboxDrainHandler(
        'alerting-service',
        { eventBridgeClient: fakeEventBridgeClient(send), ddbClient: fakeDdbClient(ddbSend) },
        { tableNameEnvVar: 'ALERTING_TABLE_NAME' },
      );
      await (handler as StreamHandler)(streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]));
      const command = ddbSend.mock.calls[0]?.[0] as { input: { TableName: string } };
      expect(command.input.TableName).toBe('boxalarm-dev-alerting-table');
    });

    it('throws naming options.tableNameEnvVar when that variable is not set', async () => {
      const { createOutboxDrainHandler } = await import('./drainHandler.js');
      const handler = createOutboxDrainHandler(
        'alerting-service',
        {},
        {
          tableNameEnvVar: 'ALERTING_TABLE_NAME',
        },
      );
      await expect((handler as StreamHandler)(streamEvent([]))).rejects.toThrow(
        'ALERTING_TABLE_NAME is required and was not set',
      );
    });

    it('publishes under options.source, ignoring a row that claims another source', async () => {
      const { createOutboxDrainHandler } = await import('./drainHandler.js');
      const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
      const handler = createOutboxDrainHandler(
        'alerting-service',
        { eventBridgeClient: fakeEventBridgeClient(send), ddbClient: fakeDdbClient(vi.fn()) },
        { source: 'alerting-service' },
      );
      await (handler as StreamHandler)(
        streamEvent([outboxRecord({ ...OUTBOX_ITEM, source: 'personnel-service' }, 'seq-1')]),
      );
      const command = send.mock.calls[0]?.[0] as {
        input: { Entries: Array<{ Source: string; Detail: string }> };
      };
      const entry = command.input.Entries[0]!;
      expect(entry.Source).toBe('alerting-service');
      expect((JSON.parse(entry.Detail) as { source: string }).source).toBe('alerting-service');
    });

    it('does not publish, retry, or mark sent an eventType outside options.allowedEventTypes', async () => {
      const { createOutboxDrainHandler } = await import('./drainHandler.js');
      const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
      const ddbSend = vi.fn().mockResolvedValue({});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const handler = createOutboxDrainHandler(
        'alerting-service',
        { eventBridgeClient: fakeEventBridgeClient(send), ddbClient: fakeDdbClient(ddbSend) },
        {
          allowedEventTypes: new Set(['dispatch.alert.received']),
          metricNamespace: 'Boxalarm/alerting-bridge',
        },
      );
      const result = await (handler as StreamHandler)(
        streamEvent([
          outboxRecord({ ...OUTBOX_ITEM, eventType: 'alerting.internal.only' }, 'seq-1'),
        ]),
      );
      expect(send).not.toHaveBeenCalled();
      expect(ddbSend).not.toHaveBeenCalled();
      expect(result).toEqual({ batchItemFailures: [] });
      const logged = errorSpy.mock.calls.map(
        (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
      );
      expect(logged).toContainEqual(
        expect.objectContaining({
          event: 'outbox.event_type_rejected',
          eventType: 'alerting.internal.only',
          service: 'alerting-service',
        }),
      );
      const metrics = logSpy.mock.calls.map(
        (call) =>
          JSON.parse(call[0] as string) as {
            EventTypeRejected?: number;
            _aws?: { CloudWatchMetrics: Array<{ Namespace: string }> };
          },
      );
      const rejected = metrics.find((line) => line.EventTypeRejected === 1);
      expect(rejected?._aws?.CloudWatchMetrics[0]?.Namespace).toBe('Boxalarm/alerting-bridge');
    });

    it('publishes the allow-listed entries of a mixed batch and drops only the rejected one', async () => {
      const { createOutboxDrainHandler } = await import('./drainHandler.js');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
      const handler = createOutboxDrainHandler(
        'alerting-service',
        { eventBridgeClient: fakeEventBridgeClient(send), ddbClient: fakeDdbClient(vi.fn()) },
        { allowedEventTypes: new Set(['inspections.preplan.updated']) },
      );
      await (handler as StreamHandler)(
        streamEvent([
          outboxRecord({ ...OUTBOX_ITEM, eventType: 'not.allowed' }, 'seq-1'),
          outboxRecord(OUTBOX_ITEM, 'seq-2'),
        ]),
      );
      expect(send).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0]?.[0] as {
        input: { Entries: Array<{ DetailType: string }> };
      };
      expect(command.input.Entries.map((e) => e.DetailType)).toEqual([
        'inspections.preplan.updated',
      ]);
    });
  });
});
