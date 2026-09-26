import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.INCIDENT_TABLE_NAME = 'incident-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function detailBody(
  envelopeOverrides: Partial<Record<string, unknown>> = {},
  payloadOverrides: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    detail: {
      eventId: 'evt-1',
      eventTime: '2026-09-14T12:00:00.000Z',
      eventType: 'apparatus.riding_assignment.assigned',
      payload: {
        deptId: 'NICHOLS',
        dispatchId: 'DISPATCH-1',
        apparatusId: 'APP-ENGINE-2',
        memberId: 'MBR-0012',
        previousMemberId: null,
        ...payloadOverrides,
      },
      ...envelopeOverrides,
    },
  });
}

function stubSend(
  route: (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown,
): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockImplementation((command: unknown) =>
      Promise.resolve(
        route(command as { constructor: { name: string }; input: Record<string, unknown> }),
      ),
    );
}

describe('ridingAssignmentConsumer handler (entrypoint, AC6)', () => {
  it('adds the memberId to assignedPositions on the INCIDENT_RESPONSE_UNIT row', async () => {
    const send = stubSend((command) => {
      if (command.constructor.name === 'GetCommand') return {};
      return {};
    });
    const { createHandler } = await import('./ridingAssignmentConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
    const values = (
      updateCall?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input.ExpressionAttributeValues;
    expect(values[':next']).toEqual(['MBR-0012']);
  });

  it('removes the previousMemberId and adds the new memberId on reassignment', async () => {
    const send = stubSend((command) => {
      if (command.constructor.name === 'GetCommand') {
        const sk = (command.input.Key as { sk: string }).sk;
        if (sk.startsWith('RESPONSE#')) {
          return { Item: { assignedPositions: ['MBR-0034'], assignedPositionsUpdatedAt: 500 } };
        }
        return {};
      }
      return {};
    });
    const { createHandler } = await import('./ridingAssignmentConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      {
        Records: [{ messageId: 'm1', body: detailBody({}, { previousMemberId: 'MBR-0034' }) }],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    const values = (
      updateCall?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input.ExpressionAttributeValues;
    expect(values[':next']).toEqual(['MBR-0012']);
  });

  it('a vacate (memberId null) removes the previous occupant without adding anyone', async () => {
    const send = stubSend((command) => {
      if (command.constructor.name === 'GetCommand') {
        const sk = (command.input.Key as { sk: string }).sk;
        if (sk.startsWith('RESPONSE#')) {
          return { Item: { assignedPositions: ['MBR-0012'], assignedPositionsUpdatedAt: 500 } };
        }
        return {};
      }
      return {};
    });
    const { createHandler } = await import('./ridingAssignmentConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      {
        Records: [
          {
            messageId: 'm1',
            body: detailBody({}, { memberId: null, previousMemberId: 'MBR-0012' }),
          },
        ],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    const values = (
      updateCall?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input.ExpressionAttributeValues;
    expect(values[':next']).toEqual([]);
  });

  it('skips a duplicate eventId redelivery without touching assignedPositions (dedup)', async () => {
    const send = stubSend((command) => {
      if (
        command.constructor.name === 'GetCommand' &&
        (command.input.Key as { sk: string }).sk === 'EVT#evt-1'
      ) {
        return { Item: { pk: 'x', sk: 'EVT#evt-1' } };
      }
      return {};
    });
    const { createHandler } = await import('./ridingAssignmentConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeUndefined();
  });

  it('reports a malformed payload as a batch item failure so SQS retries only that record', async () => {
    const send = vi.fn();
    const { createHandler } = await import('./ridingAssignmentConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    const result = await handler(
      {
        Records: [{ messageId: 'm1', body: detailBody({}, { apparatusId: undefined }) }],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a DynamoDB update failure as a batch item failure (fail-closed, SQS retry/DLQ)', async () => {
    const send = stubSend((command) => {
      if (command.constructor.name === 'GetCommand') return {};
      throw new Error('DynamoDB unavailable');
    });
    const { createHandler } = await import('./ridingAssignmentConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    const result = await handler(
      { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
  });

  it('keeps processing the rest of the batch after one record fails, reporting only the failure', async () => {
    const send = stubSend(() => ({}));
    const { createHandler } = await import('./ridingAssignmentConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    const result = await handler(
      {
        Records: [
          { messageId: 'bad', body: detailBody({}, { apparatusId: undefined }) },
          { messageId: 'good', body: detailBody({ eventId: 'evt-2' }) },
        ],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] });
    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
  });
});
