import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  badRequestProblem,
  extractTraceId,
  forbiddenProblem,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { readMemberServiceConfig } from '../config.js';

const UPDATABLE_FIELDS = ['phone', 'email', 'firstName', 'lastName'] as const;
type UpdatableField = (typeof UPDATABLE_FIELDS)[number];
type UpdateMemberBody = Partial<Record<UpdatableField, string>>;

function parseBody(raw: string | undefined | null): UpdateMemberBody | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const updates: Record<string, string> = {};
  for (const field of UPDATABLE_FIELDS) {
    const value = record[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      return undefined;
    }
    updates[field] = value;
  }
  return Object.keys(updates).length === 0 ? undefined : updates;
}

function isMemberConditionFailure(error: TransactionCanceledException): boolean {
  return error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
}

function emitPersonnelMetric(
  outcome: 'MemberProfileUpdated' | 'MemberProfileUpdateFailed',
  reason?: string,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/personnel',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [outcome]: 1,
    }),
  );
}

let cachedClient: DynamoDBDocumentClient | undefined;

function getDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  cachedClient ??= client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

async function updateMemberProfile(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  client?: DynamoDBDocumentClient,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId path parameter is required.');
  }

  const updates = parseBody(event.body);
  if (!updates) {
    return badRequestProblem(
      traceId,
      'Request body must be JSON with at least one of phone, email, firstName, lastName as a non-empty string.',
    );
  }

  const deptId = toVerifiedDeptId(principal);
  const now = Date.now();
  const eventId = randomUUID();
  const config = readMemberServiceConfig(process.env);
  const docClient = getDocClient(client);

  const nameExpressions = Object.fromEntries(
    Object.keys(updates).map((field) => [`#${field}`, field]),
  );
  const valueExpressions: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).map(([field, value]) => [`:${field}`, value]),
  );
  const setClauses = Object.keys(updates)
    .map((field) => `#${field} = :${field}`)
    .concat('#updatedAt = :updatedAt');

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: config.tableName,
              Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: 'METADATA' },
              ConditionExpression: 'attribute_exists(pk)',
              UpdateExpression: `SET ${setClauses.join(', ')}`,
              ExpressionAttributeNames: { ...nameExpressions, '#updatedAt': 'updatedAt' },
              ExpressionAttributeValues: { ...valueExpressions, ':updatedAt': now },
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
                deptId,
                memberId,
                payload: { deptId, memberId, ...updates },
                createdAt: now,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof TransactionCanceledException && isMemberConditionFailure(error)) {
      console.error(
        JSON.stringify({
          event: 'personnel.member.update.notFound',
          service: 'personnel-service',
          correlationId: traceId,
          memberId,
        }),
      );
      emitPersonnelMetric('MemberProfileUpdateFailed', 'NotFound');
      return notFoundProblem(traceId, `Member ${memberId} was not found.`);
    }
    console.error(
      JSON.stringify({
        event: 'personnel.member.update.failed',
        service: 'personnel-service',
        correlationId: traceId,
        memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitPersonnelMetric(
      'MemberProfileUpdateFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }

  emitPersonnelMetric('MemberProfileUpdated');
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, updatedAt: now, ...updates }),
  };
}

/**
 * PUT /members/{memberId} serves two Cedar actions (F2.6, AP 12):
 *  - SelfUpdateMember — a member editing their OWN profile; every role holds it.
 *  - UpdateMember — editing ANOTHER member's profile; admin-only (CHIEF/ADMIN).
 * withAuthorization binds one static action, so the request is routed to the matching
 * guard by comparing the path memberId to the authorizer's sub. The self path re-checks
 * memberId === principal.sub against the guard-verified principal before any write, so a
 * SelfUpdateMember ALLOW can never reach another member's row.
 */
export function createHandler(
  deps: { client?: DynamoDBDocumentClient; vpClient?: VerifiedPermissionsClient } = {},
) {
  const common = {
    actionType: 'Boxalarm::Action',
    resourceType: 'Boxalarm::Member',
    resourceId: (event: GuardEvent) => event.pathParameters?.memberId ?? '',
    ...(deps.vpClient ? { client: deps.vpClient } : {}),
  };

  const selfUpdate = withAuthorization(
    async (event, principal) => {
      if (event.pathParameters?.memberId !== principal.sub) {
        return forbiddenProblem(extractTraceId(event));
      }
      return updateMemberProfile(event, principal, deps.client);
    },
    { ...common, actionId: 'SelfUpdateMember' },
  );

  const adminUpdate = withAuthorization(
    (event, principal) => updateMemberProfile(event, principal, deps.client),
    { ...common, actionId: 'UpdateMember' },
  );

  return (event: GuardEvent) => {
    const callerSub = event.requestContext.authorizer?.lambda?.sub;
    const memberId = event.pathParameters?.memberId;
    return callerSub && memberId === callerSub ? selfUpdate(event) : adminUpdate(event);
  };
}

export const handler = createHandler();
