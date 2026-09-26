import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord, SQSEvent } from 'aws-lambda';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { createHandler as createDispatchAlertConsumer } from '../incident-service/dispatchAlertConsumer.js';
import { createHandler as createDispatchResponseConsumer } from '../incident-service/dispatchResponseConsumer.js';

const DEPT_ID: VerifiedDeptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

async function drainOneEntry(
  outboxItem: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { createAlertingOutboxDrainHandler } = await import('./outboxDrainHandler.js');
  const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'e-1' }] });
  const handler = createAlertingOutboxDrainHandler({
    eventBridgeClient: { send } as unknown as EventBridgeClient,
    ddbClient: { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient,
  });
  const record: DynamoDBRecord = {
    eventName: 'INSERT',
    dynamodb: {
      NewImage: marshall(outboxItem) as never,
      SequenceNumber: 'seq-1',
    },
  };
  await handler({ Records: [record] }, {} as never, () => undefined);
  const command = send.mock.calls[0]?.[0] as { input: { Entries: Array<{ Detail: string }> } };
  return JSON.parse(command.input.Entries[0]!.Detail) as Record<string, unknown>;
}

function sqsEventFromDetail(detail: Record<string, unknown>): SQSEvent {
  return {
    Records: [
      { messageId: 'msg-1', body: JSON.stringify({ detail }) } as SQSEvent['Records'][number],
    ],
  };
}

describe('platform-bus bridge contract (alerting-service producer -> incident-service consumer)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.INCIDENT_TABLE_NAME = 'incident-table';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('bridges dispatch.alert.received end to end: outbox -> EventBridge detail -> dispatchAlertConsumer', async () => {
    const outboxItem = buildOutboxRecord(
      DEPT_ID,
      'alerting-service',
      'dispatch.alert.received',
      'dispatch-1',
      {
        deptId: DEPT_ID,
        dispatchId: 'dispatch-1',
        incidentType: 'STRUCTURE_FIRE',
        address: '123 Main St',
        crossStreets: 'Elm & 1st',
        narrative: 'Smoke showing',
        dispatchedAt: 1_798_000_000,
      },
    ) as unknown as Record<string, unknown>;

    const detail = await drainOneEntry(outboxItem);

    const send = vi.fn().mockResolvedValue({});
    const consumer = createDispatchAlertConsumer({ client: { send } as never });
    await expect(
      consumer(sqsEventFromDetail(detail), {} as never, () => undefined),
    ).resolves.toEqual({ batchItemFailures: [] });

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [{ input: { Item: Record<string, unknown> } }];
    expect(command.input.Item).toMatchObject({
      pk: `DEPT#${DEPT_ID}#DISPATCH_COPY#dispatch-1`,
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
    });
  });

  it('bridges alerting.response.confirmed end to end: outbox -> EventBridge detail -> dispatchResponseConsumer', async () => {
    const outboxItem = buildOutboxRecord(
      DEPT_ID,
      'alerting-service',
      'alerting.response.confirmed',
      'dispatch-1',
      {
        deptId: DEPT_ID,
        dispatchId: 'dispatch-1',
        memberId: 'MBR-0012',
        status: 'RESPONDING',
        ackAt: 1_798_000_300,
      },
    ) as unknown as Record<string, unknown>;

    const detail = await drainOneEntry(outboxItem);

    const send = vi.fn().mockResolvedValue({});
    const consumer = createDispatchResponseConsumer({ client: { send } as never });
    await expect(
      consumer(sqsEventFromDetail(detail), {} as never, () => undefined),
    ).resolves.toEqual({ batchItemFailures: [] });

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [{ input: { Item: Record<string, unknown> } }];
    expect(command.input.Item).toMatchObject({
      pk: `DEPT#${DEPT_ID}#DISPATCH_COPY#dispatch-1`,
      sk: 'ROSTER#MBR-0012',
      status: 'RESPONDING',
      ackAt: 1_798_000_300,
    });
  });
});
