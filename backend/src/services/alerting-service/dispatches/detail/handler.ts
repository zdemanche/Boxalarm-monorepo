import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  badRequestProblem,
  extractTraceId,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { assertNoDelimiter, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../../eligibility/dynamoClient.js';
import { logError } from '../logger.js';
import { getDispatchDetail, getPrePlanCopy, type PrePlanCopyItem } from './repository.js';
import { buildMapLink } from './mapLink.js';
import { dataUnavailableProblem } from './problemDetails.js';

const METRICS_NAMESPACE = 'Boxalarm/Alerting';

// TODO(E1-S1/architecture): DISPATCH_ALERT.prePlanRefs holds pre-plan IDs (e.g. "PP-0044",
// architecture.md:637) but PRE_PLAN_COPY.sk is keyed by occupancyId (e.g. "OCCUPANCY#OCC-0231",
// architecture.md:734) — two different identifier spaces. alerting-service's data model carries
// no occupancyId anywhere, so there is currently no correct value to pass here; this lookup is a
// documented no-op (always misses, AC2's error boundary renders prePlan: null) until either
// DISPATCH_ALERT gains an occupancyId (an ingress/architecture change owned by another story) or
// PRE_PLAN_COPY grows a prePlanId-keyed access path. Do not "fix" by treating prePlanRef as an
// occupancyId — that reintroduces the silent-miss bug this comment documents.
async function fetchPrePlan(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  prePlanRef: string | undefined,
  traceId: string,
): Promise<PrePlanCopyItem | null> {
  if (!prePlanRef) {
    return null;
  }
  try {
    const item = await getPrePlanCopy(client, tableName, deptId, prePlanRef);
    return item ?? null;
  } catch (error) {
    logError('dispatches.detail.preplan_read_failed', error, { traceId, prePlanRef });
    return null;
  }
}

async function handleGetAlertDetail(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  docClient?: DynamoDBDocumentClient,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const dispatchId = event.pathParameters?.dispatchId;
  if (!dispatchId) {
    return badRequestProblem(traceId, 'dispatchId path parameter is required');
  }
  try {
    assertNoDelimiter(dispatchId, 'dispatchId');
  } catch {
    return badRequestProblem(traceId, 'dispatchId path parameter must not contain "#"');
  }

  try {
    const deptId = toVerifiedDeptId(principal);
    const config = readAlertingConfig(process.env);
    const doc = createDynamoClient(process.env, docClient);

    const item = await getDispatchDetail(doc, config.tableName, deptId, dispatchId);
    if (!item) {
      emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailViewFailed', 'NotFound');
      return notFoundProblem(traceId, `No dispatch alert found for dispatchId "${dispatchId}"`);
    }

    const prePlan = await fetchPrePlan(
      doc,
      config.tableName,
      deptId,
      item.prePlanRefs?.[0],
      traceId,
    );

    emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailViewed');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dispatchId: item.dispatchId,
        incidentType: item.incidentType,
        address: item.address,
        crossStreets: item.crossStreets,
        mapLink: item.mapLink ?? buildMapLink(item),
        narrative: item.narrative,
        eligibleMemberCount: item.eligibleMemberCount ?? null,
        fanOutStartedAt: item.fanOutStartedAt ?? null,
        toneLadder: {
          status: item.toneLadderStatus ?? 'ACTIVE',
          currentToneSequence: item.currentToneSequence ?? 1,
          nextToneAt: item.nextToneAt ?? null,
        },
        prePlan,
      }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logError('dispatches.detail.read_failed', error, {
      traceId,
      dispatchId,
      deptId: principal.deptId,
    });
    emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailViewFailed', reason);
    return dataUnavailableProblem(traceId);
  }
}

export interface AlertDetailHandlerDeps {
  readonly authzClient?: VerifiedPermissionsClient;
  readonly docClient?: DynamoDBDocumentClient;
}

export function createHandler(
  deps: AlertDetailHandlerDeps = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => handleGetAlertDetail(event, principal, deps.docClient),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ViewAlertDetail',
      resourceType: 'Boxalarm::Department',
      resourceId: (event) =>
        toVerifiedDeptId({ deptId: event.requestContext.authorizer.lambda?.deptId ?? '' }),
      ...(deps.authzClient ? { client: deps.authzClient } : {}),
    },
  );
}

export const handler = createHandler();
