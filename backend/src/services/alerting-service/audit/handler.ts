import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import {
  withAuthorization,
  badRequestProblem,
  serviceUnavailableProblem,
  extractTraceId,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import {
  InvalidCursorError,
  queryDepartmentAuditLog,
  queryMemberDeliveryHistory,
  type DepartmentAuditPage,
  type MemberAuditPage,
} from './queryAuditLog.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingAudit';

function logQueryFailure(
  reason: string,
  error: unknown,
  traceId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event: 'alerting.audit.query_failed',
      service: 'alerting-service',
      reason,
      message: error instanceof Error ? error.message : undefined,
      correlationId: traceId,
      ...extra,
    }),
  );
}

function isValidKeySegment(value: string): boolean {
  return value.length > 0 && !value.includes(',') && !value.includes('#');
}

interface MemberQuery {
  readonly memberId: string;
  readonly cursor: string | undefined;
}

interface DateRangeQuery {
  readonly from: number;
  readonly to: number;
  readonly cursor: string | undefined;
}

function parseQuery(
  qs: Record<string, string | undefined> | null | undefined,
): MemberQuery | DateRangeQuery | undefined {
  const params = qs ?? {};
  const cursor = params.cursor;
  const memberId = params.memberId;

  if (memberId !== undefined) {
    return isValidKeySegment(memberId) ? { memberId, cursor } : undefined;
  }

  const fromRaw = params.from;
  const toRaw = params.to;
  if (!fromRaw || !toRaw) {
    return undefined;
  }
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return undefined;
  }
  return { from, to, cursor };
}

function buildAuditPageResponse(
  page: MemberAuditPage | DepartmentAuditPage,
): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entries: page.entries,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    }),
  };
}

async function queryMemberAuditLog(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const parsed = parseQuery(event.queryStringParameters);
  if (!parsed || !('memberId' in parsed)) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'InvalidQueryParams');
    return badRequestProblem(traceId, 'memberId is required for this query.');
  }

  try {
    const { tableName } = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);
    const deptId = toVerifiedDeptId(principal);
    const page = await queryMemberDeliveryHistory(
      client,
      tableName,
      deptId,
      parsed.memberId,
      parsed.cursor,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryServed');
    return buildAuditPageResponse(page);
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logQueryFailure(reason, error, traceId, { memberId: parsed.memberId });
    if (error instanceof InvalidCursorError) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'InvalidCursor');
      return badRequestProblem(traceId, 'cursor is not a valid audit log pagination token.');
    }
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'DynamoUnavailable');
    return serviceUnavailableProblem(traceId);
  }
}

async function queryDepartmentAudit(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const parsed = parseQuery(event.queryStringParameters);
  if (!parsed || 'memberId' in parsed) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'InvalidQueryParams');
    return badRequestProblem(traceId, 'Provide both from and to (epoch seconds, from <= to).');
  }

  try {
    const { tableName } = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);
    const deptId = toVerifiedDeptId(principal);
    const page = await queryDepartmentAuditLog(
      client,
      tableName,
      deptId,
      parsed.from,
      parsed.to,
      parsed.cursor,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryServed');
    return buildAuditPageResponse(page);
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logQueryFailure(reason, error, traceId);
    if (error instanceof InvalidCursorError) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'InvalidCursor');
      return badRequestProblem(traceId, 'cursor is not a valid audit log pagination token.');
    }
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'DynamoUnavailable');
    return serviceUnavailableProblem(traceId);
  }
}

const authorizedMemberQuery = withAuthorization(queryMemberAuditLog, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewOwnDeliveryHistory',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.queryStringParameters?.memberId ?? '',
});

// Another member's delivery history is department audit data (F1.11, Cognito(admin)):
// ViewOwnDeliveryHistory is every-role, and Cedar cannot compare the caller with the
// queried memberId, so a query for anyone but the caller needs ViewAlertingAuditLog.
const authorizedOtherMemberQuery = withAuthorization(queryMemberAuditLog, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewAlertingAuditLog',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});

const authorizedDepartmentQuery = withAuthorization(queryDepartmentAudit, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewAlertingAuditLog',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});

export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => {
  const traceId = extractTraceId(event);
  const parsed = parseQuery(event.queryStringParameters);
  if (!parsed) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'InvalidQueryParams');
    return badRequestProblem(
      traceId,
      'Provide either memberId, or both from and to (epoch seconds, from <= to).',
    );
  }
  if ('memberId' in parsed) {
    const callerSub = event.requestContext.authorizer?.lambda?.sub;
    return parsed.memberId === callerSub
      ? authorizedMemberQuery(event)
      : authorizedOtherMemberQuery(event);
  }
  return authorizedDepartmentQuery(event);
};
