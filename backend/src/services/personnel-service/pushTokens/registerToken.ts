import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  forbiddenProblem,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoClient, readPersonnelConfig } from '../dynamoClient.js';

const ALLOWED_PLATFORMS = ['APNS', 'FCM'] as const;
type Platform = (typeof ALLOWED_PLATFORMS)[number];

export interface RegisterTokenBody {
  readonly platform: Platform;
  readonly token: string;
}

export interface ContactChannelEntry {
  readonly channel: string;
  readonly platform?: string;
  readonly token?: string;
  readonly valid?: boolean;
  readonly registeredAt?: number;
}

export function parseRegisterBody(raw: string | undefined | null): RegisterTokenBody {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('body must be valid JSON');
  }
  const body = (parsed ?? {}) as Partial<Record<string, unknown>>;
  const token = body.token;
  const platform = body.platform;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('token is required and must be a non-empty string');
  }
  if (typeof platform !== 'string' || !ALLOWED_PLATFORMS.includes(platform as Platform)) {
    throw new Error('platform is required and must be one of APNS, FCM');
  }
  return { platform: platform as Platform, token };
}

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function emitPushTokenMetric(outcome: 'Registered' | 'Failed', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/push-token',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `PushToken${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`PushToken${outcome}`]: 1,
    }),
  );
}

async function registerToken(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId path parameter is required');
  }
  // A device may only register its own member's push token. Cedar cannot compare the caller
  // with the path member (no entity attributes reach it), and RegisterPushToken /
  // RevokePushToken are every-role actions, so without this any member could point
  // another member's pages at their own device - or strip that member's token.
  if (memberId !== principal.sub) {
    return forbiddenProblem(traceId);
  }

  let body: RegisterTokenBody;
  try {
    body = parseRegisterBody(event.body);
  } catch (error) {
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid body');
  }

  const deptId = toVerifiedDeptId(principal);
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  const client = createDynamoClient(process.env);
  const config = readPersonnelConfig(process.env);

  const existing = await client.send(
    new GetCommand({ TableName: config.tableName, Key: { pk, sk: 'METADATA' } }),
  );
  if (!existing.Item) {
    return notFoundProblem(traceId, `member ${memberId} was not found`);
  }

  const currentChannels =
    (existing.Item.contactChannels as ContactChannelEntry[] | undefined) ?? [];
  const registeredAt = Date.now();
  const contactChannels: ContactChannelEntry[] = [
    ...currentChannels.filter((entry) => entry.channel !== 'PUSH'),
    { channel: 'PUSH', platform: body.platform, token: body.token, valid: true, registeredAt },
  ];

  const eventId = randomUUID();

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: config.tableName,
              Key: { pk, sk: 'METADATA' },
              ConditionExpression: 'attribute_exists(pk)',
              UpdateExpression: 'SET contactChannels = :cc, updatedAt = :ts',
              ExpressionAttributeValues: { ':cc': contactChannels, ':ts': registeredAt },
            },
          },
          {
            Put: {
              TableName: config.tableName,
              Item: {
                pk: buildDeptScopedPk(deptId, 'OUTBOX', memberId),
                sk: `EVT#${eventId}`,
                entityType: 'OUTBOX_ENTRY',
                eventId,
                eventTime: new Date(registeredAt).toISOString(),
                eventType: 'personnel.member.updated',
                source: 'personnel-service',
                correlationId: memberId,
                schemaVersion: '1.0',
                payload: { memberId, deptId, contactChannels },
                sentAt: null,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    const cancellationReasons =
      error instanceof TransactionCanceledException
        ? (error.CancellationReasons?.map((r) => r.Code) ?? [])
        : undefined;
    console.error(
      JSON.stringify({
        event: 'personnel.pushToken.register.failed',
        service: 'personnel-service',
        correlationId: traceId,
        memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
        cancellationReasons,
      }),
    );
    if (
      error instanceof TransactionCanceledException &&
      cancellationReasons?.includes('ConditionalCheckFailed')
    ) {
      emitPushTokenMetric('Failed', 'ConditionalCheckFailed');
      return notFoundProblem(traceId, `member ${memberId} was not found`);
    }
    emitPushTokenMetric('Failed', 'UnknownError');
    throw error;
  }

  console.log(
    JSON.stringify({
      event: 'personnel.pushToken.registered',
      service: 'personnel-service',
      correlationId: traceId,
      memberId,
    }),
  );
  emitPushTokenMetric('Registered');

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, channel: 'PUSH', registered: true }),
  };
}

export const handler = withAuthorization(registerToken, {
  actionType: 'MEMBER',
  actionId: 'RegisterPushToken',
  resourceType: 'MEMBER',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
