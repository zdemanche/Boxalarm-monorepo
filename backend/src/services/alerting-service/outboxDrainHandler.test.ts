import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { BRIDGE_EVENT_TYPES } from './platformBusBridge.js';

// Generic drain behavior (chunking, partial FailedEntryCount, mixed-batch failure,
// MODIFY/REMOVE skip, mark-sent) is covered once in
// packages/outbox/src/drainHandler.test.ts. This file pins only the alerting wiring:
// table env, fixed Source, and the bridge allow-list.

type StreamHandler = (e: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>;

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function insertRecord(item: Record<string, unknown>, sequenceNumber: string): DynamoDBRecord {
  return {
    eventName: 'INSERT',
    dynamodb: { NewImage: marshall(item) as never, SequenceNumber: sequenceNumber },
  };
}

function outboxItem(eventType: string, source = 'alerting-service'): Record<string, unknown> {
  return buildOutboxRecord(DEPT_ID, source, eventType, 'dispatch-1', {
    dispatchId: 'dispatch-1',
  }) as unknown as Record<string, unknown>;
}

async function buildHandler() {
  const { createAlertingOutboxDrainHandler } = await import('./outboxDrainHandler.js');
  const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
  const ddbSend = vi.fn().mockResolvedValue({});
  const handler = createAlertingOutboxDrainHandler({
    eventBridgeClient: { send } as unknown as EventBridgeClient,
    ddbClient: { send: ddbSend } as unknown as DynamoDBDocumentClient,
  }) as StreamHandler;
  return { handler, send, ddbSend };
}

describe('alerting-service outboxDrainHandler (platform-bus bridge)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.ALERTING_TABLE_NAME = 'boxalarm-dev-alerting-table';
    delete process.env.PLATFORM_TABLE_NAME;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('throws before any AWS call when ALERTING_TABLE_NAME is not set (entrypoint test)', async () => {
    delete process.env.ALERTING_TABLE_NAME;
    const { handler } = await import('./outboxDrainHandler.js');
    await expect(
      (handler as StreamHandler)({
        Records: [insertRecord(outboxItem(BRIDGE_EVENT_TYPES[0]), 's')],
      }),
    ).rejects.toThrow('ALERTING_TABLE_NAME is required and was not set');
  });

  it('throws before any AWS call when PLATFORM_EVENT_BUS_NAME is not set (entrypoint test)', async () => {
    delete process.env.PLATFORM_EVENT_BUS_NAME;
    const { handler } = await import('./outboxDrainHandler.js');
    await expect((handler as StreamHandler)({ Records: [] })).rejects.toThrow(
      'PLATFORM_EVENT_BUS_NAME is required and was not set',
    );
  });

  it.each(BRIDGE_EVENT_TYPES)(
    'bridges allow-listed %s to the platform bus as alerting-service and marks it sent on the alerting table',
    async (eventType) => {
      const { handler, send, ddbSend } = await buildHandler();
      const result = await handler({ Records: [insertRecord(outboxItem(eventType), 'seq-1')] });
      expect(result).toEqual({ batchItemFailures: [] });
      const command = send.mock.calls[0]?.[0] as {
        input: { Entries: Array<{ EventBusName: string; Source: string; DetailType: string }> };
      };
      expect(command.input.Entries).toEqual([
        expect.objectContaining({
          EventBusName: 'boxalarm-dev-platform-bus',
          Source: 'alerting-service',
          DetailType: eventType,
        }),
      ]);
      const update = ddbSend.mock.calls[0]?.[0] as { input: { TableName: string } };
      expect(update.input.TableName).toBe('boxalarm-dev-alerting-table');
    },
  );

  it('publishes under Source alerting-service even when the row claims another source', async () => {
    const { handler, send } = await buildHandler();
    await handler({
      Records: [insertRecord(outboxItem('dispatch.alert.received', 'personnel-service'), 'seq-1')],
    });
    const command = send.mock.calls[0]?.[0] as { input: { Entries: Array<{ Source: string }> } };
    expect(command.input.Entries[0]?.Source).toBe('alerting-service');
  });

  it('does not publish or mark sent an alerting OUTBOX_ENTRY outside the bridge allow-list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler, send, ddbSend } = await buildHandler();
    const result = await handler({
      Records: [insertRecord(outboxItem('alerting.delivery.receipt.recorded'), 'seq-1')],
    });
    expect(send).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });
});
