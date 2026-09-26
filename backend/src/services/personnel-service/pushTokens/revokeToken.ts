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
import type { ContactChannelEntry } from './registerToken.js';

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function emitRevokeMetric(outcome: 'Revoked' | 'Failed', reason?: string): void {
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

async function revokeToken(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId path parameter is required');
  }
  // A device may only revoke its own member's push token. Cedar cannot compare the caller
  // with the path member (no entity attributes reach it), and RegisterPushToken /
  // RevokePushToken are every-role actions, so without this any member could point
  // another member's pages at their own device - or strip that member's token.
  if (memberId !== principal.sub) {
    return forbiddenProblem(traceId);
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
  const contactChannels = currentChannels.filter((entry) => entry.channel !== 'PUSH');
  const now = Date.now();
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
              ExpressionAttributeValues: { ':cc': contactChannels, ':ts': now },
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
                eventTime: new Date(now).toISOString(),
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
        event: 'personnel.pushToken.revoke.failed',
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
      emitRevokeMetric('Failed', 'ConditionalCheckFailed');
      return notFoundProblem(traceId, `member ${memberId} was not found`);
    }
    emitRevokeMetric('Failed', 'UnknownError');
    throw error;
  }

  console.log(
    JSON.stringify({
      event: 'personnel.pushToken.revoked',
      service: 'personnel-service',
      correlationId: traceId,
      memberId,
    }),
  );
  emitRevokeMetric('Revoked');

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, channel: 'PUSH', revoked: true }),
  };
}

export const handler = withAuthorization(revokeToken, {
  actionType: 'MEMBER',
  actionId: 'RevokePushToken',
  resourceType: 'MEMBER',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
