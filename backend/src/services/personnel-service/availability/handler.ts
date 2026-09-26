import { createHash, randomUUID } from 'node:crypto';
import {
  ActionAfterCompletion,
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
} from '@aws-sdk/client-scheduler';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  badRequestProblem,
  forbiddenProblem,
  withAuthorization,
  type GuardEvent,
} from '@boxalarm/authz';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { TransitionAction } from './expiryHandler.js';
import { createDdbClient, readPersonnelDdbConfig } from './dynamoClient.js';

const METRIC_NAMESPACE = 'Boxalarm/personnel-availability';
const MAX_EPOCH_SECONDS = 4_102_444_800;

function conflictProblem(detail: string, traceId: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 409,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/conflict',
      title: 'Conflict',
      status: 409,
      detail,
      traceId,
    }),
  };
}

interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

interface SchedulerConfig {
  readonly expiryHandlerFunctionArn: string;
  readonly schedulerRoleArn: string;
}

function readSchedulerConfig(env: NodeJS.ProcessEnv): SchedulerConfig {
  const expiryHandlerFunctionArn = env.AVAILABILITY_EXPIRY_HANDLER_ARN;
  const schedulerRoleArn = env.AVAILABILITY_SCHEDULER_ROLE_ARN;
  if (!expiryHandlerFunctionArn) {
    throw new Error('AVAILABILITY_EXPIRY_HANDLER_ARN is required and was not set');
  }
  if (!schedulerRoleArn) {
    throw new Error('AVAILABILITY_SCHEDULER_ROLE_ARN is required and was not set');
  }
  return { expiryHandlerFunctionArn, schedulerRoleArn };
}

let cachedSchedulerClient: SchedulerClient | undefined;

function getSchedulerClient(client?: SchedulerClient): SchedulerClient {
  cachedSchedulerClient ??= client ?? AWSXRay.captureAWSv3Client(new SchedulerClient({}));
  return cachedSchedulerClient;
}

interface ParsedBody {
  readonly startAt: number;
  readonly endAt: number;
  readonly reason: string | undefined;
}

function isPlausibleEpochSeconds(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < MAX_EPOCH_SECONDS;
}

function parseBody(body: string | undefined): ParsedBody | { error: string } {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : {};
  } catch {
    return { error: 'Request body must be valid JSON.' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'Request body must be a JSON object.' };
  }
  const { startAt, endAt, reason } = raw as Record<string, unknown>;
  if (typeof startAt !== 'number' || !isPlausibleEpochSeconds(startAt)) {
    return { error: 'startAt is required and must be a whole-number epoch-second value.' };
  }
  if (typeof endAt !== 'number' || !isPlausibleEpochSeconds(endAt)) {
    return { error: 'endAt is required and must be a whole-number epoch-second value.' };
  }
  if (endAt <= startAt) {
    return { error: 'endAt must be strictly after startAt.' };
  }
  if (endAt <= Math.floor(Date.now() / 1000)) {
    return { error: 'endAt must be in the future.' };
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return { error: 'reason must be a string when present.' };
  }
  return { startAt, endAt, reason };
}

function logError(
  event: string,
  error: unknown,
  correlationId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'personnel-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

export interface MarkAvailabilityDeps {
  readonly schedulerClient?: SchedulerClient;
}

function dependencyUnavailableProblem(traceId: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 503,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/service-unavailable',
      title: 'Service Unavailable',
      status: 503,
      detail: 'Unable to record availability at this time.',
      traceId,
    }),
  };
}

/**
 * EventBridge Scheduler names are capped at 64 chars ([0-9a-zA-Z-_.]). The readable form
 * `avail-{deptId}-{memberId}-{startAt}` is already 64 chars for a 36-char Cognito sub and
 * deptId `nichols-fd`, so a `-start`/`-end` suffix got truncated away and the two schedules
 * of a future-dated markoff collided. A 40-hex-char sha256 of the same triple keeps the name
 * deterministic and unique per markoff at a fixed 46 chars, and keeps the `avail-` prefix the
 * create Lambda's IAM resource pattern (schedule/default/avail-*) matches.
 */
export function availabilityScheduleBaseName(
  deptId: string,
  memberId: string,
  startAt: number,
): string {
  const digest = createHash('sha256').update(`${deptId}#${memberId}#${startAt}`).digest('hex');
  return `avail-${digest.slice(0, 40)}`;
}

interface ScheduleSpec {
  readonly action: TransitionAction;
  readonly at: number;
  readonly suffix: string;
}

async function deleteSchedules(
  scheduler: SchedulerClient,
  names: readonly string[],
  traceId: string,
): Promise<void> {
  for (const name of names) {
    try {
      await scheduler.send(new DeleteScheduleCommand({ Name: name }));
    } catch (error) {
      logError('availability.schedule_cleanup_failed', error, traceId, { scheduleName: name });
    }
  }
}

export async function createAvailability(
  event: GuardEvent,
  principal: { sub: string; deptId: string },
  deps: MarkAvailabilityDeps = {},
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;

  if (!memberId || memberId !== principal.sub) {
    logError('availability.forbidden', new Error('memberId does not match principal'), traceId);
    return forbiddenProblem(traceId);
  }

  const parsed = parseBody(event.body);
  if ('error' in parsed) {
    return badRequestProblem(traceId, parsed.error);
  }

  const schedulerConfig = readSchedulerConfig(process.env);
  const deptId = toVerifiedDeptId(principal);
  const { tableName } = readPersonnelDdbConfig(process.env);
  const eventId = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const activatesImmediately = parsed.startAt <= nowSeconds;

  const markoffItem = {
    pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
    sk: `MARKOFF#${parsed.startAt}`,
    entityType: 'AVAILABILITY_MARKOFF' as const,
    memberId,
    deptId,
    startAt: parsed.startAt,
    endAt: parsed.endAt,
    affectsAlerting: true,
    ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    ...(activatesImmediately ? { activatedAt: nowSeconds } : {}),
  };

  const outboxItem = {
    pk: buildDeptScopedPk(deptId, 'OUTBOX', 'MEMBER', memberId),
    sk: `EVT#${eventId}`,
    entityType: 'OUTBOX_ENTRY' as const,
    eventId,
    eventType: 'personnel.availability.changed',
    correlationId: memberId,
    createdAt: nowSeconds,
    payload: {
      deptId,
      memberId,
      availabilityState: 'MARKED_OFF',
      startAt: parsed.startAt,
      endAt: parsed.endAt,
    },
  };

  const scheduler = getSchedulerClient(deps.schedulerClient);
  const scheduleBaseName = availabilityScheduleBaseName(deptId, memberId, parsed.startAt);
  const schedulesToCreate: readonly ScheduleSpec[] = activatesImmediately
    ? [{ action: 'REVERT', at: parsed.endAt, suffix: 'end' }]
    : [
        { action: 'ACTIVATE', at: parsed.startAt, suffix: 'start' },
        { action: 'REVERT', at: parsed.endAt, suffix: 'end' },
      ];

  const createdScheduleNames: string[] = [];
  try {
    for (const schedule of schedulesToCreate) {
      const scheduleName = `${scheduleBaseName}-${schedule.suffix}`;
      await scheduler.send(
        new CreateScheduleCommand({
          Name: scheduleName,
          ScheduleExpression: `at(${new Date(schedule.at * 1000).toISOString().slice(0, 19)})`,
          // One-time at() schedules otherwise linger after firing and accumulate toward the
          // account's Scheduler quota (#327 review SUG-1).
          ActionAfterCompletion: ActionAfterCompletion.DELETE,
          FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
          Target: {
            Arn: schedulerConfig.expiryHandlerFunctionArn,
            RoleArn: schedulerConfig.schedulerRoleArn,
            Input: JSON.stringify({
              deptId,
              memberId,
              startAt: parsed.startAt,
              action: schedule.action,
            }),
          },
        }),
      );
      createdScheduleNames.push(scheduleName);
    }
  } catch (error) {
    logError('availability.schedule_failed', error, traceId);
    await deleteSchedules(scheduler, createdScheduleNames, traceId);
    emitOutcomeMetric(METRIC_NAMESPACE, 'MarkoffFailed', 'SchedulerUnavailable');
    return dependencyUnavailableProblem(traceId);
  }

  try {
    const ddb = createDdbClient(process.env);
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: markoffItem,
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
          ...(activatesImmediately ? [{ Put: { TableName: tableName, Item: outboxItem } }] : []),
        ],
      }),
    );
  } catch (error) {
    await deleteSchedules(scheduler, createdScheduleNames, traceId);
    const cancellation = asTransactionCancellation(error);
    if (cancellation) {
      const reasons = cancellation.CancellationReasons ?? [];
      logError('availability.write_conflict', error, traceId, {
        cancellationReasons: reasons.map((r) => r.Code),
      });
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        emitOutcomeMetric(METRIC_NAMESPACE, 'MarkoffFailed', 'DuplicateWindow');
        return conflictProblem(
          'A markoff already exists for this member starting at this time.',
          traceId,
        );
      }
      emitOutcomeMetric(METRIC_NAMESPACE, 'MarkoffFailed', 'DynamoDbUnavailable');
      return dependencyUnavailableProblem(traceId);
    }
    logError('availability.write_failed', error, traceId);
    emitOutcomeMetric(METRIC_NAMESPACE, 'MarkoffFailed', 'DynamoDbUnavailable');
    return dependencyUnavailableProblem(traceId);
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'MarkoffCreated');
  return {
    statusCode: 201,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      memberId,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      affectsAlerting: true,
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    }),
  };
}

export const handler = withAuthorization(createAvailability, {
  actionType: 'Boxalarm::Action',
  actionId: 'MarkAvailability',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
