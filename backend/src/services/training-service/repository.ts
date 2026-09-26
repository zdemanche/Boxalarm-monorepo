import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { logError, type TrainingConfig } from './client.js';

const QUERY_PAGE_SIZE = 100;
const EPOCH_SORT_WIDTH = 13;

function padEpochSortKey(value: number): string {
  return String(value).padStart(EPOCH_SORT_WIDTH, '0');
}

export interface TrainingEventInput {
  readonly title: string;
  readonly category: string;
  readonly startAt: number;
  readonly endAt: number;
}

export interface TrainingEvent extends TrainingEventInput {
  readonly eventId: string;
}

export interface AttendeeHoursInput {
  readonly memberId: string;
  readonly hours: number;
}

export interface DateRange {
  readonly from: number;
  readonly to: number;
}

export interface AttendanceHoursRecord {
  readonly memberId: string;
  readonly category: string;
  readonly hours: number;
}

export interface AttendanceRecord extends AttendanceHoursRecord {
  readonly eventId: string;
}

export class DuplicateSignupError extends Error {
  constructor() {
    super('Member is already signed up for this training event');
    this.name = 'DuplicateSignupError';
  }
}

function toTrainingEvent(item: Record<string, unknown>): TrainingEvent {
  return {
    eventId: item.eventId as string,
    title: item.title as string,
    category: item.category as string,
    startAt: item.startAt as number,
    endAt: item.endAt as number,
  };
}

function toAttendanceHoursRecord(item: Record<string, unknown>): AttendanceHoursRecord {
  return {
    memberId: item.memberId as string,
    category: item.category as string,
    hours: typeof item.hours === 'number' ? item.hours : 0,
  };
}

async function queryAllPages(
  client: DynamoDBDocumentClient,
  buildCommand: (exclusiveStartKey?: Record<string, unknown>) => QueryCommand,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const output = await client.send(buildCommand(exclusiveStartKey));
    items.push(...(output.Items ?? []));
    exclusiveStartKey = output.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

export async function createTrainingEvent(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  input: TrainingEventInput,
): Promise<TrainingEvent> {
  const eventId = randomUUID();
  await client.send(
    new PutCommand({
      TableName: config.tableName,
      Item: {
        pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', eventId),
        sk: 'METADATA',
        entityType: 'TRAINING_EVENT',
        eventId,
        title: input.title,
        category: input.category,
        startAt: input.startAt,
        endAt: input.endAt,
        gsi3pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT'),
        gsi3sk: padEpochSortKey(input.startAt),
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
  return { eventId, ...input };
}

export async function listTrainingEvents(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
): Promise<readonly TrainingEvent[]> {
  const items = await queryAllPages(
    client,
    (exclusiveStartKey) =>
      new QueryCommand({
        TableName: config.tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'TRAINING_EVENT') },
        ScanIndexForward: true,
        Limit: QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
  );
  return items.map(toTrainingEvent);
}

export async function getTrainingEvent(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  eventId: string,
): Promise<TrainingEvent | undefined> {
  const output = await client.send(
    new GetCommand({
      TableName: config.tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', eventId), sk: 'METADATA' },
    }),
  );
  return output.Item ? toTrainingEvent(output.Item) : undefined;
}

export async function listMemberAttendanceEventIds(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  memberId: string,
): Promise<ReadonlySet<string>> {
  const items = await queryAllPages(
    client,
    (exclusiveStartKey) =>
      new QueryCommand({
        TableName: config.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: {
          ':gsi1pk': `MEMBER#${memberId}`,
          ':prefix': 'TRAINING_ATTENDANCE#',
        },
        ProjectionExpression: 'eventId',
        Limit: QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
  );
  return new Set(items.map((item) => item.eventId as string));
}

export interface MemberAttendanceRecord {
  readonly eventId: string;
  readonly category: string;
  readonly hours: number;
  readonly startAt: number;
}

const ATTENDANCE_GSI1SK_PREFIX = 'TRAINING_ATTENDANCE#';

function toMemberAttendanceRecord(item: Record<string, unknown>): MemberAttendanceRecord {
  const gsi1sk = item.gsi1sk as string;
  return {
    eventId: item.eventId as string,
    category: item.category as string,
    hours: (item.hours as number | undefined) ?? 0,
    startAt: Number(gsi1sk.slice(ATTENDANCE_GSI1SK_PREFIX.length)),
  };
}

// GSI1's MEMBER#{memberId} partition carries no department, so the caller's department is
// enforced on the base-table pk (DEPT#{deptId}#TRAINING_EVENT#...) — the same scoping
// listMemberAttendanceInRange applies — keeping a second department additive (#327 MIN-4).
export async function listMemberAttendanceRecords(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  memberId: string,
): Promise<readonly MemberAttendanceRecord[]> {
  const deptPrefix = `${buildDeptScopedPk(deptId, 'TRAINING_EVENT')}#`;
  const items = await queryAllPages(
    client,
    (exclusiveStartKey) =>
      new QueryCommand({
        TableName: config.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
        FilterExpression: 'begins_with(pk, :deptPrefix)',
        ExpressionAttributeValues: {
          ':gsi1pk': `MEMBER#${memberId}`,
          ':prefix': ATTENDANCE_GSI1SK_PREFIX,
          ':deptPrefix': deptPrefix,
        },
        ProjectionExpression: 'eventId, category, hours, gsi1sk',
        Limit: QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
  );
  return items.map(toMemberAttendanceRecord);
}

export async function listTrainingEventsInRange(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  range: DateRange,
): Promise<readonly TrainingEvent[]> {
  const items = await queryAllPages(
    client,
    (exclusiveStartKey) =>
      new QueryCommand({
        TableName: config.tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk AND gsi3sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':gsi3pk': buildDeptScopedPk(deptId, 'TRAINING_EVENT'),
          ':from': padEpochSortKey(range.from),
          ':to': padEpochSortKey(range.to),
        },
        ScanIndexForward: true,
        Limit: QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
  );
  return items.map(toTrainingEvent);
}

export async function listEventAttendees(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  eventId: string,
): Promise<readonly AttendanceHoursRecord[]> {
  const items = await queryAllPages(
    client,
    (exclusiveStartKey) =>
      new QueryCommand({
        TableName: config.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'TRAINING_EVENT', eventId),
          ':prefix': 'ATTENDEE#',
        },
        Limit: QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
  );
  return items.map(toAttendanceHoursRecord);
}

const ATTENDANCE_PREFIX_LENGTH = 'TRAINING_ATTENDANCE#'.length;

// ponytail: same unpadded-numeric-sort-key issue as listTrainingEventsInRange had — queries the
// full begins_with(gsi1sk, 'TRAINING_ATTENDANCE#') prefix (as listMemberAttendanceEventIds
// already does) and filters by the startAt encoded in gsi1sk app-side, rather than a
// DynamoDB BETWEEN bound that would compare lexicographically
export async function listMemberAttendanceInRange(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  memberId: string,
  range: DateRange,
): Promise<readonly AttendanceHoursRecord[]> {
  const deptPrefix = `${buildDeptScopedPk(deptId, 'TRAINING_EVENT')}#`;
  const items = await queryAllPages(
    client,
    (exclusiveStartKey) =>
      new QueryCommand({
        TableName: config.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: {
          ':gsi1pk': `MEMBER#${memberId}`,
          ':prefix': 'TRAINING_ATTENDANCE#',
        },
        Limit: QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
  );
  return items
    .filter((item) => typeof item.pk === 'string' && item.pk.startsWith(deptPrefix))
    .filter((item) => {
      const startAt = Number(String(item.gsi1sk).slice(ATTENDANCE_PREFIX_LENGTH));
      return startAt >= range.from && startAt <= range.to;
    })
    .map(toAttendanceHoursRecord);
}

export async function createSignupAttendance(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  event: TrainingEvent,
  memberId: string,
): Promise<void> {
  try {
    await client.send(
      new PutCommand({
        TableName: config.tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', event.eventId),
          sk: `ATTENDEE#${memberId}`,
          entityType: 'TRAINING_ATTENDANCE',
          eventId: event.eventId,
          memberId,
          category: event.category,
          gsi1pk: `MEMBER#${memberId}`,
          gsi1sk: `TRAINING_ATTENDANCE#${event.startAt}`,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      logError('training.repository.signup.duplicate', error, {
        deptId,
        eventId: event.eventId,
        memberId,
      });
      throw new DuplicateSignupError();
    }
    throw error;
  }
}

const ATTENDANCE_FAN_OUT_CONCURRENCY = 10;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// Reuses listTrainingEventsInRange/listEventAttendees (E3-S5) rather than re-querying GSI3/the
// base table inline, so the ISO report rides the same zero-padded gsi3sk BETWEEN bound as every
// other range query on this table instead of a second, divergent implementation.
export async function listAttendanceForPeriod(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  periodStart: number,
  periodEnd: number,
): Promise<readonly AttendanceRecord[]> {
  const events = await listTrainingEventsInRange(client, config, deptId, {
    from: periodStart,
    to: periodEnd,
  });

  const attendanceByEvent = await mapWithConcurrency(
    events,
    ATTENDANCE_FAN_OUT_CONCURRENCY,
    async (event) => {
      const attendees = await listEventAttendees(client, config, deptId, event.eventId);
      return attendees
        .filter((attendee) => attendee.hours > 0)
        .map((attendee) => ({ ...attendee, eventId: event.eventId }));
    },
  );

  return attendanceByEvent.flat();
}

export async function recordAttendanceHours(
  client: DynamoDBDocumentClient,
  config: TrainingConfig,
  deptId: VerifiedDeptId,
  event: TrainingEvent,
  attendees: readonly AttendeeHoursInput[],
): Promise<void> {
  const pk = buildDeptScopedPk(deptId, 'TRAINING_EVENT', event.eventId);
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: attendees.map((attendee) => ({
          Update: {
            TableName: config.tableName,
            Key: { pk, sk: `ATTENDEE#${attendee.memberId}` },
            UpdateExpression:
              'SET hours = :hours, ' +
              'entityType = if_not_exists(entityType, :entityType), ' +
              'eventId = if_not_exists(eventId, :eventId), ' +
              'memberId = if_not_exists(memberId, :memberId), ' +
              'category = if_not_exists(category, :category), ' +
              'gsi1pk = if_not_exists(gsi1pk, :gsi1pk), ' +
              'gsi1sk = if_not_exists(gsi1sk, :gsi1sk)',
            ExpressionAttributeValues: {
              ':hours': attendee.hours,
              ':entityType': 'TRAINING_ATTENDANCE',
              ':eventId': event.eventId,
              ':memberId': attendee.memberId,
              ':category': event.category,
              ':gsi1pk': `MEMBER#${attendee.memberId}`,
              ':gsi1sk': `TRAINING_ATTENDANCE#${event.startAt}`,
            },
          },
        })),
      }),
    );
  } catch (error) {
    logError('training.repository.record_hours.failed', error, { deptId, eventId: event.eventId });
    throw error;
  }
}
