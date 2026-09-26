import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createSignupAttendance,
  createTrainingEvent,
  DuplicateSignupError,
  getTrainingEvent,
  listAttendanceForPeriod,
  listEventAttendees,
  listMemberAttendanceEventIds,
  listMemberAttendanceInRange,
  listMemberAttendanceRecords,
  listTrainingEvents,
  listTrainingEventsInRange,
  recordAttendanceHours,
} from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });
const CONFIG = { tableName: 'platform-table' };
const EVENT = { eventId: 'e1', title: 't', category: 'ems', startAt: 1_000, endAt: 2_000 };

function fakeClient(sendImpl: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send: vi.fn(sendImpl) } as unknown as DynamoDBDocumentClient;
}

describe('createTrainingEvent', () => {
  it('writes a department-scoped TRAINING_EVENT item with GSI3 attributes derived from startAt (AC1)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return {};
    });

    const result = await createTrainingEvent(client, CONFIG, DEPT_ID, {
      title: 'Ladder Ops',
      category: 'fireground',
      startAt: 1_000,
      endAt: 2_000,
    });

    expect(result.title).toBe('Ladder Ops');
    const item = captured!.input.Item as Record<string, unknown>;
    expect(item.pk).toBe(`DEPT#dept-001#TRAINING_EVENT#${result.eventId}`);
    expect(item.sk).toBe('METADATA');
    expect(item.gsi3pk).toBe('DEPT#dept-001#TRAINING_EVENT');
    expect(item.gsi3sk).toBe('0000000001000');
    expect(captured!.input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });
});

describe('listTrainingEvents', () => {
  it('queries GSI3 ascending by start time, paged via LastEvaluatedKey, mapped back to TrainingEvent (AC1)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    let callCount = 0;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      callCount += 1;
      if (callCount === 1) {
        return {
          Items: [{ eventId: 'e1', title: 'Drill 1', category: 'ems', startAt: 100, endAt: 200 }],
          LastEvaluatedKey: { pk: 'p1', sk: 's1' },
        };
      }
      return {
        Items: [{ eventId: 'e2', title: 'Drill 2', category: 'ems', startAt: 300, endAt: 400 }],
      };
    });

    const events = await listTrainingEvents(client, CONFIG, DEPT_ID);

    expect(callCount).toBe(2);
    expect(captured!.input.IndexName).toBe('GSI3');
    expect(captured!.input.ScanIndexForward).toBe(true);
    expect(captured!.input.Limit).toBeGreaterThan(0);
    expect(captured!.input.ExpressionAttributeValues).toEqual({
      ':gsi3pk': 'DEPT#dept-001#TRAINING_EVENT',
    });
    expect(events.map((e) => e.eventId)).toEqual(['e1', 'e2']);
  });
});

describe('getTrainingEvent', () => {
  it('returns undefined when no item is found', async () => {
    const client = fakeClient(() => ({}));
    expect(await getTrainingEvent(client, CONFIG, DEPT_ID, 'missing')).toBeUndefined();
  });
});

describe('listMemberAttendanceEventIds', () => {
  it('queries GSI1 for MEMBER#{memberId} attendance items, projected to eventId, paged via LastEvaluatedKey', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    let callCount = 0;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      callCount += 1;
      if (callCount === 1) {
        return { Items: [{ eventId: 'e1' }], LastEvaluatedKey: { gsi1pk: 'p', gsi1sk: 's' } };
      }
      return { Items: [{ eventId: 'e2' }] };
    });

    const ids = await listMemberAttendanceEventIds(client, CONFIG, 'member-1');

    expect(callCount).toBe(2);
    expect(captured!.input.IndexName).toBe('GSI1');
    expect(captured!.input.KeyConditionExpression).toBe(
      'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
    );
    expect(captured!.input.ExpressionAttributeValues).toEqual({
      ':gsi1pk': 'MEMBER#member-1',
      ':prefix': 'TRAINING_ATTENDANCE#',
    });
    expect(captured!.input.ProjectionExpression).toBe('eventId');
    expect(ids).toEqual(new Set(['e1', 'e2']));
  });
});

describe('listMemberAttendanceRecords', () => {
  it('queries GSI1 for MEMBER#{memberId} attendance, projecting hours/category/gsi1sk, across multiple categories and pages (AC1)', async () => {
    let callCount = 0;
    const client = fakeClient(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          Items: [
            { eventId: 'e1', category: 'LADDER_OPS', hours: 3, gsi1sk: 'TRAINING_ATTENDANCE#100' },
          ],
          LastEvaluatedKey: { gsi1pk: 'p', gsi1sk: 's' },
        };
      }
      return {
        Items: [{ eventId: 'e2', category: 'EMS', hours: 2, gsi1sk: 'TRAINING_ATTENDANCE#200' }],
      };
    });

    const records = await listMemberAttendanceRecords(client, CONFIG, DEPT_ID, 'member-1');

    expect(callCount).toBe(2);
    expect(records).toEqual([
      { eventId: 'e1', category: 'LADDER_OPS', hours: 3, startAt: 100 },
      { eventId: 'e2', category: 'EMS', hours: 2, startAt: 200 },
    ]);
  });

  it('defaults hours to 0 for a signed-up-but-not-yet-recorded attendance record', async () => {
    const client = fakeClient(() => ({
      Items: [{ eventId: 'e1', category: 'LADDER_OPS', gsi1sk: 'TRAINING_ATTENDANCE#100' }],
    }));

    const records = await listMemberAttendanceRecords(client, CONFIG, DEPT_ID, 'member-1');

    expect(records).toEqual([{ eventId: 'e1', category: 'LADDER_OPS', hours: 0, startAt: 100 }]);
  });

  it('returns an empty array for a member with no attendance history (AC3)', async () => {
    const client = fakeClient(() => ({}));

    const records = await listMemberAttendanceRecords(client, CONFIG, DEPT_ID, 'member-1');

    expect(records).toEqual([]);
  });

  it("filters to the caller's department on the base-table pk (GSI1 carries no deptId)", async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return {};
    });

    await listMemberAttendanceRecords(client, CONFIG, DEPT_ID, 'member-1');

    expect(captured?.input.FilterExpression).toBe('begins_with(pk, :deptPrefix)');
    expect(
      (captured?.input.ExpressionAttributeValues as Record<string, string>)[':deptPrefix'],
    ).toBe('DEPT#dept-001#TRAINING_EVENT#');
  });
});

describe('listTrainingEventsInRange', () => {
  it('queries GSI3 with a native zero-padded BETWEEN bound on gsi3sk instead of fetching the full dept history (AP26, AC2)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return {
        Items: [{ eventId: 'in-range', title: 't', category: 'ems', startAt: 1_500, endAt: 1_600 }],
      };
    });

    const events = await listTrainingEventsInRange(client, CONFIG, DEPT_ID, {
      from: 1_000,
      to: 2_000,
    });

    expect(captured!.input.IndexName).toBe('GSI3');
    expect(captured!.input.KeyConditionExpression).toBe(
      'gsi3pk = :gsi3pk AND gsi3sk BETWEEN :from AND :to',
    );
    expect(captured!.input.ExpressionAttributeValues).toEqual({
      ':gsi3pk': 'DEPT#dept-001#TRAINING_EVENT',
      ':from': '0000000001000',
      ':to': '0000000002000',
    });
    expect(events.map((event) => event.eventId)).toEqual(['in-range']);
  });

  it('returns an empty array when the date range spans zero TRAINING_EVENT rows', async () => {
    const client = fakeClient(() => ({ Items: [] }));
    expect(await listTrainingEventsInRange(client, CONFIG, DEPT_ID, { from: 0, to: 1 })).toEqual(
      [],
    );
  });
});

describe('listEventAttendees', () => {
  it('queries the base table for ATTENDEE# items in the event partition (AP26, AC2)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return { Items: [{ memberId: 'member-1', category: 'ems', hours: 2 }] };
    });

    const attendees = await listEventAttendees(client, CONFIG, DEPT_ID, 'e1');

    expect(captured!.input.KeyConditionExpression).toBe('pk = :pk AND begins_with(sk, :prefix)');
    expect(captured!.input.ExpressionAttributeValues).toEqual({
      ':pk': 'DEPT#dept-001#TRAINING_EVENT#e1',
      ':prefix': 'ATTENDEE#',
    });
    expect(attendees).toEqual([{ memberId: 'member-1', category: 'ems', hours: 2 }]);
  });

  it('defaults hours to 0 for an attendee with no hours recorded yet', async () => {
    const client = fakeClient(() => ({ Items: [{ memberId: 'member-1', category: 'ems' }] }));
    const attendees = await listEventAttendees(client, CONFIG, DEPT_ID, 'e1');
    expect(attendees).toEqual([{ memberId: 'member-1', category: 'ems', hours: 0 }]);
  });
});

describe('listMemberAttendanceInRange', () => {
  it('queries GSI1 for the attendance prefix and filters by the startAt encoded in gsi1sk (AP25, AC1/AC3)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return {
        Items: [
          {
            pk: 'DEPT#dept-001#TRAINING_EVENT#e1',
            memberId: 'member-1',
            category: 'fireground',
            hours: 3,
            gsi1sk: 'TRAINING_ATTENDANCE#150',
          },
          {
            pk: 'DEPT#dept-001#TRAINING_EVENT#e2',
            memberId: 'member-1',
            category: 'ems',
            hours: 9,
            gsi1sk: 'TRAINING_ATTENDANCE#999',
          },
        ],
      };
    });

    const records = await listMemberAttendanceInRange(client, CONFIG, DEPT_ID, 'member-1', {
      from: 100,
      to: 200,
    });

    expect(captured!.input.IndexName).toBe('GSI1');
    expect(captured!.input.KeyConditionExpression).toBe(
      'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
    );
    expect(captured!.input.ExpressionAttributeValues).toEqual({
      ':gsi1pk': 'MEMBER#member-1',
      ':prefix': 'TRAINING_ATTENDANCE#',
    });
    expect(records).toEqual([{ memberId: 'member-1', category: 'fireground', hours: 3 }]);
  });

  it('excludes attendance recorded under a different department for the same memberId (tenant isolation)', async () => {
    const client = fakeClient(() => ({
      Items: [
        {
          pk: 'DEPT#dept-001#TRAINING_EVENT#e1',
          memberId: 'member-1',
          category: 'fireground',
          hours: 3,
          gsi1sk: 'TRAINING_ATTENDANCE#150',
        },
        {
          pk: 'DEPT#dept-002#TRAINING_EVENT#e9',
          memberId: 'member-1',
          category: 'ems',
          hours: 50,
          gsi1sk: 'TRAINING_ATTENDANCE#150',
        },
      ],
    }));

    const records = await listMemberAttendanceInRange(client, CONFIG, DEPT_ID, 'member-1', {
      from: 100,
      to: 200,
    });

    expect(records).toEqual([{ memberId: 'member-1', category: 'fireground', hours: 3 }]);
  });
});

describe('createSignupAttendance', () => {
  it('writes a TRAINING_ATTENDANCE item denormalizing category and building gsi1pk/gsi1sk from the event (AC2/AC3)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return {};
    });

    await createSignupAttendance(client, CONFIG, DEPT_ID, EVENT, 'member-1');

    const item = captured!.input.Item as Record<string, unknown>;
    expect(item.pk).toBe('DEPT#dept-001#TRAINING_EVENT#e1');
    expect(item.sk).toBe('ATTENDEE#member-1');
    expect(item.category).toBe('ems');
    expect(item.gsi1pk).toBe('MEMBER#member-1');
    expect(item.gsi1sk).toBe('TRAINING_ATTENDANCE#1000');
    expect(item.hours).toBeUndefined();
  });

  it('throws DuplicateSignupError, logging the original ConditionalCheckFailedException first, on a repeat signup (409 row)', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
    });

    await expect(
      createSignupAttendance(client, CONFIG, DEPT_ID, EVENT, 'member-1'),
    ).rejects.toThrow(DuplicateSignupError);
    expect(logSpy.mock.calls[0]?.[0] as string).toContain('ConditionalCheckFailedException');
    logSpy.mockRestore();
  });
});

describe('listAttendanceForPeriod', () => {
  it('delegates to listTrainingEventsInRange/listEventAttendees, reading the same TRAINING_ATTENDANCE items recordAttendanceHours writes, via the same zero-padded gsi3sk BETWEEN bound (AC2)', async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    const client = fakeClient((command) => {
      const captured = command as { input: Record<string, unknown> };
      calls.push(captured);
      if (captured.input.IndexName === 'GSI3') {
        return { Items: [{ eventId: 'e1' }, { eventId: 'e2' }] };
      }
      const pk = (captured.input.ExpressionAttributeValues as Record<string, unknown>)[':pk'];
      if (pk === 'DEPT#dept-001#TRAINING_EVENT#e1') {
        return { Items: [{ eventId: 'e1', memberId: 'member-1', category: 'ems', hours: 3 }] };
      }
      return { Items: [{ eventId: 'e2', memberId: 'member-2', category: 'ladder', hours: 2 }] };
    });

    const records = await listAttendanceForPeriod(client, CONFIG, DEPT_ID, 1_000, 2_000);

    const gsi3Call = calls.find((c) => c.input.IndexName === 'GSI3')!;
    expect(gsi3Call.input.KeyConditionExpression).toBe(
      'gsi3pk = :gsi3pk AND gsi3sk BETWEEN :from AND :to',
    );
    expect(gsi3Call.input.ExpressionAttributeValues).toEqual({
      ':gsi3pk': 'DEPT#dept-001#TRAINING_EVENT',
      ':from': '0000000001000',
      ':to': '0000000002000',
    });
    expect(records).toEqual(
      expect.arrayContaining([
        { eventId: 'e1', memberId: 'member-1', category: 'ems', hours: 3 },
        { eventId: 'e2', memberId: 'member-2', category: 'ladder', hours: 2 },
      ]),
    );
  });

  it('returns an empty list, not an error, when no events fall in the period (AC3)', async () => {
    const client = fakeClient(() => ({ Items: [] }));

    const records = await listAttendanceForPeriod(client, CONFIG, DEPT_ID, 1_000, 2_000);

    expect(records).toEqual([]);
  });

  it('excludes ATTENDEE# rows with no recorded hours (signup-only, no hours attribute) rather than propagating a zero-hour phantom entry (P3)', async () => {
    const client = fakeClient((command) => {
      const captured = command as { input: Record<string, unknown> };
      if (captured.input.IndexName === 'GSI3') {
        return { Items: [{ eventId: 'e1' }] };
      }
      return {
        Items: [
          { eventId: 'e1', memberId: 'member-1', category: 'ems', hours: 3 },
          { eventId: 'e1', memberId: 'member-2', category: 'ems' },
        ],
      };
    });

    const records = await listAttendanceForPeriod(client, CONFIG, DEPT_ID, 1_000, 2_000);

    expect(records).toEqual([{ eventId: 'e1', memberId: 'member-1', category: 'ems', hours: 3 }]);
  });

  it('bounds attendee fan-out concurrency while still fetching every in-period event (P1)', async () => {
    const eventIds = Array.from({ length: 25 }, (_, i) => `e${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const client = fakeClient(async (command) => {
      const captured = command as { input: Record<string, unknown> };
      if (captured.input.IndexName === 'GSI3') {
        return { Items: eventIds.map((eventId) => ({ eventId })) };
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const pk = (captured.input.ExpressionAttributeValues as Record<string, unknown>)[':pk'];
      const eventId = (pk as string).split('#').pop();
      return { Items: [{ eventId, memberId: 'member-1', category: 'ems', hours: 1 }] };
    });

    const records = await listAttendanceForPeriod(client, CONFIG, DEPT_ID, 1_000, 2_000);

    expect(records).toHaveLength(25);
    expect(maxInFlight).toBe(10);
  });
});

describe('recordAttendanceHours', () => {
  it('uses TransactWriteItems (never BatchWriteItem) with one upsert Update per attendee, including a walk-in never signed up (AC3)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return {};
    });

    await recordAttendanceHours(client, CONFIG, DEPT_ID, EVENT, [
      { memberId: 'member-1', hours: 2 },
      { memberId: 'never-signed-up', hours: 3 },
    ]);

    const items = captured!.input.TransactItems as Array<{ Update: Record<string, unknown> }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.Update.ConditionExpression).toBeUndefined();
    expect(items[0]!.Update.Key).toEqual({
      pk: 'DEPT#dept-001#TRAINING_EVENT#e1',
      sk: 'ATTENDEE#member-1',
    });
    expect(items[1]!.Update.ExpressionAttributeValues).toEqual({
      ':hours': 3,
      ':entityType': 'TRAINING_ATTENDANCE',
      ':eventId': 'e1',
      ':memberId': 'never-signed-up',
      ':category': 'ems',
      ':gsi1pk': 'MEMBER#never-signed-up',
      ':gsi1sk': 'TRAINING_ATTENDANCE#1000',
    });
  });

  it('logs the original error then rethrows an unrelated TransactWriteItems failure without swallowing it', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeClient(() => {
      throw new Error('DynamoDB unavailable');
    });

    await expect(
      recordAttendanceHours(client, CONFIG, DEPT_ID, EVENT, [{ memberId: 'm1', hours: 1 }]),
    ).rejects.toThrow('DynamoDB unavailable');
    expect(logSpy.mock.calls[0]?.[0] as string).toContain('DynamoDB unavailable');
    logSpy.mockRestore();
  });
});
