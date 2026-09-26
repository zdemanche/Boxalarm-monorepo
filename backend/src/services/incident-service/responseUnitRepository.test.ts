import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { IncidentNotFoundError } from './repository.js';
import { upsertResponseUnitTimes } from './responseUnitRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE_NAME = 'boxalarm-dev-incident';
const TRACE_ID = 'trace-abc-123';

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

interface TransactInput {
  readonly TransactItems: ReadonlyArray<{
    readonly ConditionCheck?: { Key: { sk: string }; ConditionExpression: string };
    readonly Update?: { Key: { pk: string; sk: string }; UpdateExpression: string };
    readonly Put?: { Item: Record<string, unknown> };
  }>;
}

type SentCommand = { constructor: { name: string }; input: unknown };

/** Transact succeeds; the read-back Get returns `item`. */
function fakeSend(item: Record<string, unknown>): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockImplementation((command: SentCommand) =>
      Promise.resolve(command.constructor.name === 'GetCommand' ? { Item: item } : {}),
    );
}

function transactOf(send: ReturnType<typeof vi.fn>): TransactInput[] {
  return send.mock.calls
    .map(([command]) => command as SentCommand)
    .filter((command) => command.constructor.name === 'TransactWriteCommand')
    .map((command) => command.input as TransactInput);
}

describe('upsertResponseUnitTimes', () => {
  it('independently sets each provided timestamp field (E6-S5 AC1)', async () => {
    const send = fakeSend({
      incidentId: 'NICHOLS-4471-1798000000',
      unitId: 'E1',
      unitType: 'APPARATUS',
      dispatchedAt: 100,
      arrivedAt: 200,
    });
    const result = await upsertResponseUnitTimes(
      fakeClient(send),
      TABLE_NAME,
      {
        deptId: DEPT_ID,
        incidentId: 'NICHOLS-4471-1798000000',
        unitId: 'E1',
        unitType: 'APPARATUS',
        times: { dispatchedAt: 100, arrivedAt: 200 },
      },
      TRACE_ID,
    );

    expect(result).toMatchObject({ unitId: 'E1', dispatchedAt: 100, arrivedAt: 200 });
    const update = transactOf(send)[0]?.TransactItems[1]?.Update;
    expect(update?.Key).toEqual({
      pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
      sk: 'RESPONSE#E1',
    });
    expect(update?.UpdateExpression).toMatch(/dispatchedAt = :dispatchedAt/);
    expect(update?.UpdateExpression).toMatch(/arrivedAt = :arrivedAt/);
    expect(update?.UpdateExpression).not.toMatch(/enRouteAt/);
  });

  it('keys distinct units under distinct sk values for the same incident (E6-S5 AC3)', async () => {
    const send = fakeSend({ incidentId: 'X', unitId: 'MBR-1', unitType: 'MEMBER' });

    await upsertResponseUnitTimes(
      fakeClient(send),
      TABLE_NAME,
      {
        deptId: DEPT_ID,
        incidentId: 'NICHOLS-4471-1798000000',
        unitId: 'MBR-1',
        unitType: 'MEMBER',
        times: { arrivedAt: 300 },
      },
      TRACE_ID,
    );
    await upsertResponseUnitTimes(
      fakeClient(send),
      TABLE_NAME,
      {
        deptId: DEPT_ID,
        incidentId: 'NICHOLS-4471-1798000000',
        unitId: 'E1',
        unitType: 'APPARATUS',
        times: { arrivedAt: 305 },
      },
      TRACE_ID,
    );

    const keys = transactOf(send).map((input) => input.TransactItems[1]?.Update?.Key.sk);
    expect(keys).toEqual(['RESPONSE#MBR-1', 'RESPONSE#E1']);
  });

  it('commits the parent-exists check, the unit update and an incident.response_unit.updated outbox entry atomically', async () => {
    const send = fakeSend({ incidentId: 'NICHOLS-4471-1798000000', unitId: 'E1' });

    await upsertResponseUnitTimes(
      fakeClient(send),
      TABLE_NAME,
      {
        deptId: DEPT_ID,
        incidentId: 'NICHOLS-4471-1798000000',
        unitId: 'E1',
        unitType: 'APPARATUS',
        times: { arrivedAt: 200 },
      },
      TRACE_ID,
    );

    const [transact] = transactOf(send);
    expect(transact?.TransactItems[0]?.ConditionCheck).toMatchObject({
      Key: { sk: 'METADATA' },
      ConditionExpression: 'attribute_exists(pk)',
    });
    expect(transact?.TransactItems[2]?.Put?.Item).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'incident.response_unit.updated',
      source: 'incident-service',
      correlationId: TRACE_ID,
      payload: {
        incidentId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        unitId: 'E1',
        unitType: 'APPARATUS',
        arrivedAt: 200,
      },
    });
  });

  it('rejects with IncidentNotFoundError instead of creating an orphan RESPONSE# item for a bad incidentId', async () => {
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      }),
    );

    await expect(
      upsertResponseUnitTimes(
        fakeClient(send),
        TABLE_NAME,
        {
          deptId: DEPT_ID,
          incidentId: 'NICHOLS-9999',
          unitId: 'E1',
          unitType: 'APPARATUS',
          times: { arrivedAt: 100 },
        },
        TRACE_ID,
      ),
    ).rejects.toThrow(IncidentNotFoundError);

    // The cancelled transaction wrote nothing and no read-back was attempted.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-conditional transaction failure unchanged', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));

    await expect(
      upsertResponseUnitTimes(
        fakeClient(send),
        TABLE_NAME,
        {
          deptId: DEPT_ID,
          incidentId: 'NICHOLS-4471-1798000000',
          unitId: 'E1',
          unitType: 'APPARATUS',
          times: { arrivedAt: 100 },
        },
        TRACE_ID,
      ),
    ).rejects.toThrow('DynamoDB unavailable');
  });
});
