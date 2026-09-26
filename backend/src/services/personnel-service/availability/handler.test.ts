import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent } from '@boxalarm/authz';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const PRINCIPAL = { sub: 'mbr-102', deptId: 'NICHOLS', 'cognito:groups': 'member' };
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const FUTURE_START = NOW_SECONDS + 3600;
const FUTURE_END = NOW_SECONDS + 7200;
const PAST_START = NOW_SECONDS - 3600;

function buildEvent(
  overrides: Partial<GuardEvent> = {},
  principal: Record<string, unknown> | undefined = PRINCIPAL,
  body: Record<string, unknown> = { startAt: PAST_START, endAt: FUTURE_END, reason: 'Vacation' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/personnel/members/{memberId}/availability',
    rawPath: '/api/v1/personnel/members/mbr-102/availability',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId: 'mbr-102' },
    body: JSON.stringify(body),
    requestContext: { authorizer: { lambda: principal } },
    ...overrides,
  } as unknown as GuardEvent;
}

describe('personnel availability handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    process.env.AVAILABILITY_EXPIRY_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:expiry';
    process.env.AVAILABILITY_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates an AVAILABILITY_MARKOFF with affectsAlerting=true and an outbox entry in one transaction, then schedules only the revert (AC1, AC2 — window already started)', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return { ...actual, createDdbClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
    });
    const schedulerSend = vi.fn().mockResolvedValue({});
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(buildEvent(), PRINCIPAL, {
      schedulerClient: { send: schedulerSend } as unknown as SchedulerClient,
    });

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as { affectsAlerting: boolean };
    expect(body.affectsAlerting).toBe(true);

    const transactCall = send.mock.calls[0]?.[0] as {
      input: { TransactItems: { Put: { Item: Record<string, unknown> } }[] };
    };
    const items = transactCall.input.TransactItems.map((t) => t.Put.Item);
    expect(items).toContainEqual(
      expect.objectContaining({ entityType: 'AVAILABILITY_MARKOFF', affectsAlerting: true }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        entityType: 'OUTBOX_ENTRY',
        eventType: 'personnel.availability.changed',
      }),
    );
    expect(schedulerSend).toHaveBeenCalledOnce();
    const scheduleCall = schedulerSend.mock.calls[0]?.[0] as {
      input: {
        ScheduleExpression: string;
        Target: { Arn: string; RoleArn: string; Input: string };
      };
    };
    expect(JSON.parse(scheduleCall.input.Target.Input)).toMatchObject({ action: 'REVERT' });
    expect(scheduleCall.input.ScheduleExpression).toBe(
      `at(${new Date(FUTURE_END * 1000).toISOString().slice(0, 19)})`,
    );
    expect(scheduleCall.input.Target.Arn).toBe('arn:aws:lambda:us-east-1:1:function:expiry');
    expect(scheduleCall.input.Target.RoleArn).toBe('arn:aws:iam::1:role/scheduler');
  });

  it('does not emit a MARKED_OFF outbox entry at creation for a future-dated window, and schedules both ACTIVATE and REVERT (AC3 future-window)', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return { ...actual, createDdbClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
    });
    const schedulerSend = vi.fn().mockResolvedValue({});
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(
      buildEvent({}, PRINCIPAL, { startAt: FUTURE_START, endAt: FUTURE_END }),
      PRINCIPAL,
      { schedulerClient: { send: schedulerSend } as unknown as SchedulerClient },
    );

    expect(result).toMatchObject({ statusCode: 201 });
    const transactCall = send.mock.calls[0]?.[0] as {
      input: { TransactItems: { Put: { Item: Record<string, unknown> } }[] };
    };
    expect(transactCall.input.TransactItems).toHaveLength(1);
    expect(transactCall.input.TransactItems[0]?.Put.Item).toMatchObject({
      entityType: 'AVAILABILITY_MARKOFF',
    });
    expect(transactCall.input.TransactItems[0]?.Put.Item.activatedAt).toBeUndefined();

    expect(schedulerSend).toHaveBeenCalledTimes(2);
    const actions = schedulerSend.mock.calls.map(
      (call) =>
        (
          JSON.parse((call[0] as { input: { Target: { Input: string } } }).input.Target.Input) as {
            action: string;
          }
        ).action,
    );
    expect(actions.sort()).toEqual(['ACTIVATE', 'REVERT']);
  });

  it('gives the ACTIVATE and REVERT schedules distinct <=64-char avail- names for a realistic 36-char sub and deptId nichols-fd (MAJ-3)', async () => {
    const sub = '3f9a1c2e-7b4d-4e8f-9a0b-1c2d3e4f5a6b';
    const principal = { sub, deptId: 'nichols-fd', 'cognito:groups': 'member' };
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return { ...actual, createDdbClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
    });
    const schedulerSend = vi.fn().mockResolvedValue({});
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(
      buildEvent(
        { pathParameters: { memberId: sub } },
        principal,
        // Future-dated (10-digit epoch seconds), so both ACTIVATE and REVERT are scheduled.
        { startAt: FUTURE_START, endAt: FUTURE_END },
      ),
      principal,
      { schedulerClient: { send: schedulerSend } as unknown as SchedulerClient },
    );

    expect(result).toMatchObject({ statusCode: 201 });
    const inputs = schedulerSend.mock.calls.map(
      (call) => (call[0] as { input: { Name: string; ActionAfterCompletion: string } }).input,
    );
    const names = inputs.map((input) => input.Name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/^avail-[0-9a-f]{40}-(start|end)$/);
    }
    // SUG-1: one-time schedules delete themselves after firing.
    expect(inputs.every((input) => input.ActionAfterCompletion === 'DELETE')).toBe(true);
  });

  it('derives a deterministic schedule base name per (dept, member, startAt)', async () => {
    const { availabilityScheduleBaseName } = await import('./handler.js');
    const sub = '3f9a1c2e-7b4d-4e8f-9a0b-1c2d3e4f5a6b';
    const a = availabilityScheduleBaseName('nichols-fd', sub, 1_790_000_000);
    expect(a).toBe(availabilityScheduleBaseName('nichols-fd', sub, 1_790_000_000));
    expect(a).not.toBe(availabilityScheduleBaseName('nichols-fd', sub, 1_790_000_001));
    expect(a).not.toBe(availabilityScheduleBaseName('other-fd', sub, 1_790_000_000));
    expect(`${a}-start`.length).toBeLessThanOrEqual(64);
  });

  it('403s with a detail explaining the mismatch when memberId does not match the authenticated principal (self-only)', async () => {
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(
      buildEvent({ pathParameters: { memberId: 'someone-else' } }),
      PRINCIPAL,
    );
    expect(result).toMatchObject({ statusCode: 403 });
    const body = JSON.parse((result as { body: string }).body) as { detail: string };
    expect(body.detail).toContain('not authorized');
  });

  it('400s with a validation detail when startAt/endAt are missing', async () => {
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(buildEvent({ body: JSON.stringify({}) }), PRINCIPAL);
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { detail: string };
    expect(body.detail).toContain('startAt is required');
  });

  it('400s with a validation detail when startAt is non-numeric', async () => {
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(
      buildEvent({ body: JSON.stringify({ startAt: 'x', endAt: FUTURE_END }) }),
      PRINCIPAL,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { detail: string };
    expect(body.detail).toContain('startAt is required');
  });

  it('400s with a validation detail when endAt<=startAt', async () => {
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(
      buildEvent({ body: JSON.stringify({ startAt: FUTURE_END, endAt: FUTURE_START }) }),
      PRINCIPAL,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { detail: string };
    expect(body.detail).toContain('strictly after startAt');
  });

  it('400s with a validation detail when endAt is in the past', async () => {
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(
      buildEvent({ body: JSON.stringify({ startAt: PAST_START - 7200, endAt: PAST_START }) }),
      PRINCIPAL,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { detail: string };
    expect(body.detail).toContain('must be in the future');
  });

  it('400s a millisecond-unit endAt instead of silently misinterpreting it as epoch seconds', async () => {
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(
      buildEvent({ body: JSON.stringify({ startAt: PAST_START, endAt: Date.now() + 3_600_000 }) }),
      PRINCIPAL,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { detail: string };
    expect(body.detail).toContain('whole-number epoch-second value');
  });

  it('returns 503 and cleans up the created schedule when the DynamoDB transact write fails (no stranded schedule)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ddb unavailable'));
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return { ...actual, createDdbClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
    });
    const schedulerSend = vi.fn().mockResolvedValue({});
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(buildEvent(), PRINCIPAL, {
      schedulerClient: { send: schedulerSend } as unknown as SchedulerClient,
    });
    expect(result).toMatchObject({ statusCode: 503 });
    const createCalls = schedulerSend.mock.calls.filter(
      (call) =>
        (call[0] as { constructor: { name: string } }).constructor.name === 'CreateScheduleCommand',
    );
    const deleteCalls = schedulerSend.mock.calls.filter(
      (call) =>
        (call[0] as { constructor: { name: string } }).constructor.name === 'DeleteScheduleCommand',
    );
    expect(createCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(1);
  });

  it('returns 409 (not a retryable 503) when the markoff already exists for this member/startAt', async () => {
    const conflictError = Object.assign(new Error('conflict'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockRejectedValue(conflictError);
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return { ...actual, createDdbClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
    });
    const schedulerSend = vi.fn().mockResolvedValue({});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(buildEvent(), PRINCIPAL, {
      schedulerClient: { send: schedulerSend } as unknown as SchedulerClient,
    });
    expect(result).toMatchObject({ statusCode: 409 });
    errorSpy.mockRestore();
  });

  it('returns 503 (never rethrows uncontrolled) and never writes to DynamoDB when Scheduler CreateSchedule fails', async () => {
    const send = vi.fn();
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return { ...actual, createDdbClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const schedulerSend = vi.fn().mockRejectedValue(new Error('scheduler outage'));
    const { createAvailability } = await import('./handler.js');
    const result = await createAvailability(buildEvent(), PRINCIPAL, {
      schedulerClient: { send: schedulerSend } as unknown as SchedulerClient,
    });
    expect(result).toMatchObject({ statusCode: 503 });
    expect(send).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('availability.schedule_failed'));
    errorSpy.mockRestore();
  });

  it('exercises the exported, authz-wrapped Lambda handler end to end (entrypoint-test obligation): 401s (fail-secure) when no bearer token or principal is present, before any DynamoDB call', async () => {
    const send = vi.fn();
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return { ...actual, createDdbClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
    });
    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent({ headers: undefined } as never, PRINCIPAL));
    expect(result).toMatchObject({ statusCode: 401 });
    expect(send).not.toHaveBeenCalled();
  });
});
