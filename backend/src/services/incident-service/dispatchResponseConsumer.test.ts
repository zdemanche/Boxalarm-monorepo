import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createHandler } from './dispatchResponseConsumer.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.INCIDENT_TABLE_NAME = 'incident-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function sqsEvent(bodies: string[]): SQSEvent {
  return {
    Records: bodies.map(
      (body, index) => ({ messageId: `msg-${index}`, body }) as SQSEvent['Records'][number],
    ),
  };
}

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    detail: {
      payload: {
        deptId: 'NICHOLS',
        dispatchId: 'NICHOLS-MANUAL-1798000000-abcd1234',
        memberId: 'MBR-0034',
        status: 'RESPONDING',
        ackAt: 1_798_000_050,
        ...overrides,
      },
    },
  });
}

describe('dispatchResponseConsumer', () => {
  it('writes a roster copy entry keyed by memberId (E6-S2 AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const handler = createHandler({ client: { send } as never });

    await handler(sqsEvent([validBody()]), {} as never, () => undefined);

    const [command] = send.mock.calls[0] as [{ input: { Item: Record<string, unknown> } }];
    expect(command.input.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#DISPATCH_COPY#NICHOLS-MANUAL-1798000000-abcd1234',
      sk: 'ROSTER#MBR-0034',
      memberId: 'MBR-0034',
      status: 'RESPONDING',
    });
  });

  it('does not throw when a stale ackAt loses the conditional write (last-writer-wins)', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'stale', $metadata: {} }));
    const handler = createHandler({ client: { send } as never });

    await expect(handler(sqsEvent([validBody()]), {} as never, () => undefined)).resolves.toEqual({
      batchItemFailures: [],
    });
  });

  it('reports only the malformed record as a batch item failure and still writes the valid one', async () => {
    const send = vi.fn().mockResolvedValue({});
    const handler = createHandler({ client: { send } as never });

    const result = await handler(
      sqsEvent([JSON.stringify({ detail: { payload: {} } }), validBody()]),
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-0' }] });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports a failed DynamoDB write as a batch item failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    const handler = createHandler({ client: { send } as never });

    const result = await handler(sqsEvent([validBody()]), {} as never, () => undefined);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-0' }] });
  });
});
