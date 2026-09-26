import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

vi.mock('../eligibility/selector.js', () => ({
  queryEligibleMembers: vi.fn(),
}));

vi.mock('../escalation/scheduleEscalation.js', () => ({
  createEscalationSchedule: vi.fn().mockResolvedValue('esc-schedule'),
}));

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

interface FakeTransactItem {
  Put?: { Item: Record<string, unknown> };
}

function createFakeDdb(): {
  send: DynamoDBDocumentClient['send'];
  puts: Record<string, unknown>[];
  failNextIdempotencyKeys: Set<string>;
} {
  const puts: Record<string, unknown>[] = [];
  const failNextIdempotencyKeys = new Set<string>();
  const send = vi.fn((command: unknown) => {
    const input = (command as { input: { TransactItems: FakeTransactItem[] } }).input;
    for (const item of input.TransactItems) {
      const key = item.Put?.Item.idempotencyKey as string | undefined;
      if (key && failNextIdempotencyKeys.has(key)) {
        const error = new Error('conditional check failed');
        error.name = 'TransactionCanceledException';
        throw error;
      }
    }
    for (const item of input.TransactItems) {
      if (item.Put) {
        puts.push(item.Put.Item);
      }
    }
    return Promise.resolve({});
  });
  return { send: send, puts, failNextIdempotencyKeys };
}

describe('runFanOut', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('writes one push and one sms receipt plus a roster entry per eligible member, in a single transact call each', async () => {
    const { queryEligibleMembers } = await import('../eligibility/selector.js');
    vi.mocked(queryEligibleMembers).mockResolvedValue([
      { memberId: 'mbr-1', quals: ['INTERIOR'] } as never,
      { memberId: 'mbr-2', quals: [] } as never,
    ]);
    const { runFanOut } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb();

    await runFanOut(
      { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
      { send: vi.fn() } as unknown as SchedulerClient,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      1798000000,
    );

    expect(fakeDdb.send).toHaveBeenCalledTimes(2);
    const mbr1Items = fakeDdb.puts.filter((item) => item.memberId === 'mbr-1');
    expect(mbr1Items.map((item) => item.sk)).toEqual(
      expect.arrayContaining(['RECEIPT#mbr-1#push#1', 'RECEIPT#mbr-1#sms#1', 'ROSTER#mbr-1']),
    );
    const roster = mbr1Items.find((item) => item.entityType === 'DISPATCH_ROSTER_ENTRY');
    expect(roster).toMatchObject({ ackStatus: 'NONE', currentChannelTier: 'primary' });
  });

  it('creates an escalation schedule per eligible member', async () => {
    const { queryEligibleMembers } = await import('../eligibility/selector.js');
    vi.mocked(queryEligibleMembers).mockResolvedValue([{ memberId: 'mbr-1', quals: [] } as never]);
    const { createEscalationSchedule } = await import('../escalation/scheduleEscalation.js');
    const { runFanOut } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb();

    await runFanOut(
      { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
      { send: vi.fn() } as unknown as SchedulerClient,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      1798000000,
    );

    expect(createEscalationSchedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dispatchId: 'dispatch-1', memberId: 'mbr-1', toneSequence: 1 }),
      expect.anything(),
      'alerting-table',
    );
  });

  it('treats a duplicate tone-1 replay (conditional put collision) as a no-op, not a throw', async () => {
    const { queryEligibleMembers } = await import('../eligibility/selector.js');
    vi.mocked(queryEligibleMembers).mockResolvedValue([{ memberId: 'mbr-1', quals: [] } as never]);
    const { runFanOut } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb();
    fakeDdb.failNextIdempotencyKeys.add('dispatch-1#1#mbr-1#push');

    await expect(
      runFanOut(
        { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
        { send: vi.fn() } as unknown as SchedulerClient,
        'alerting-table',
        DEPT_ID,
        'dispatch-1',
        1798000000,
      ),
    ).resolves.toBeUndefined();
  });

  it('logs and continues, without throwing, when the scheduler create fails for one member', async () => {
    const { queryEligibleMembers } = await import('../eligibility/selector.js');
    vi.mocked(queryEligibleMembers).mockResolvedValue([
      { memberId: 'mbr-1', quals: [] } as never,
      { memberId: 'mbr-2', quals: [] } as never,
    ]);
    const { createEscalationSchedule } = await import('../escalation/scheduleEscalation.js');
    vi.mocked(createEscalationSchedule).mockRejectedValueOnce(new Error('scheduler down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runFanOut } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb();

    await expect(
      runFanOut(
        { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
        { send: vi.fn() } as unknown as SchedulerClient,
        'alerting-table',
        DEPT_ID,
        'dispatch-1',
        1798000000,
      ),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler down'));
    expect(createEscalationSchedule).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the eligibility query is unavailable', async () => {
    const { queryEligibleMembers } = await import('../eligibility/selector.js');
    vi.mocked(queryEligibleMembers).mockRejectedValue(new Error('table unreachable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runFanOut } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb();

    await expect(
      runFanOut(
        { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
        { send: vi.fn() } as unknown as SchedulerClient,
        'alerting-table',
        DEPT_ID,
        'dispatch-1',
        1798000000,
      ),
    ).rejects.toThrow('table unreachable');
  });
});
