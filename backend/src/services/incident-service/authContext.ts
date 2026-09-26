import type {
  APIGatewayProxyEventHeaders,
  APIGatewayProxyEventV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { assertNoDelimiter, toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';

export type IncidentEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

export interface IncidentAuthContext {
  readonly deptId: VerifiedDeptId;
  readonly sub: string;
  readonly isAdmin: boolean;
  /** ADMIN, CHIEF, or OFFICER — submission status read and manual retry. */
  readonly canManageSubmission: boolean;
}

const ADMIN_GROUPS = new Set(['ADMIN', 'CHIEF']);
const SUBMISSION_GROUPS = new Set(['ADMIN', 'CHIEF', 'OFFICER']);

// TODO(E8-S3): replace with a Verified Permissions IsAuthorizedWithToken Cedar check once the
// admin/officer role policy exists; this parses the authorizer's already-verified
// cognito:groups claim as an interim, fail-secure stand-in, not a permanent substitute.
function hasGroup(groups: string, allowed: ReadonlySet<string>): boolean {
  return groups.split(' ').some((group) => allowed.has(group));
}

export function readAuthorizerContext(event: IncidentEvent): IncidentAuthContext {
  const lambdaContext = event.requestContext.authorizer?.lambda as
    Partial<AuthorizerContext> | undefined;
  const rawDeptId = lambdaContext?.deptId;
  if (typeof rawDeptId !== 'string' || rawDeptId.trim().length === 0) {
    throw new Error('authorizer context deptId is required and was not present on the event');
  }
  const rawSub = lambdaContext?.sub;
  if (typeof rawSub !== 'string' || rawSub.trim().length === 0) {
    throw new Error('authorizer context sub is required and was not present on the event');
  }
  const rawGroups = lambdaContext?.['cognito:groups'];
  const groups = typeof rawGroups === 'string' ? rawGroups : '';
  return {
    deptId: toVerifiedDeptId({ deptId: rawDeptId }),
    sub: rawSub,
    isAdmin: hasGroup(groups, ADMIN_GROUPS),
    canManageSubmission: hasGroup(groups, SUBMISSION_GROUPS),
  };
}

export interface ProblemResponse {
  readonly statusCode: number;
  readonly headers: { readonly 'Content-Type': string };
  readonly body: string;
}

// Mirrors personnel-service/lib/problemDetails.ts's resolveTraceId: the caller's W3C
// traceparent header takes precedence so a reported failure can be joined to the caller's
// trace; the request id is the fallback when no traceparent was sent.
export function resolveTraceId(headers: APIGatewayProxyEventHeaders, fallback: string): string {
  const traceparent = headers.traceparent ?? headers.Traceparent;
  if (traceparent) {
    const parts = traceparent.split('-');
    if (parts.length === 4 && parts[1]) {
      return parts[1];
    }
  }
  return fallback;
}

/**
 * RFC 7807 problem+json response. `extensions` carries problem-specific members (e.g.
 * per-field validation `errors`); it cannot override the standard members.
 */
export function problemResponse(
  status: number,
  title: string,
  detail: string,
  traceId: string,
  extensions: Readonly<Record<string, unknown>> = {},
): ProblemResponse {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/problem+json' },
    body: JSON.stringify({ ...extensions, type: 'about:blank', title, status, detail, traceId }),
  };
}

export function emitIncidentMetric(name: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/incident-service',
            Dimensions: [[]],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      [name]: 1,
    }),
  );
}

export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A request-body problem whose message is safe to return as the 400 detail. */
export class RequestValidationError extends Error {}

function parseJsonObjectBody(event: IncidentEvent): Record<string, unknown> {
  if (!event.body) {
    throw new RequestValidationError('request body is required');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RequestValidationError('request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export type IncidentWriteRequest<T> =
  | {
      readonly ok: true;
      readonly traceId: string;
      readonly deptId: VerifiedDeptId;
      readonly incidentId: string;
      readonly input: T;
    }
  | { readonly ok: false; readonly response: ProblemResponse };

/**
 * Shared preamble for the incident write routes (`PUT /incidents/{incidentId}[/…]`):
 * resolves the traceId, reads the authorizer's dept scope (401, logged as `deniedEvent`),
 * validates the incidentId path parameter (400), and parses the JSON-object body with
 * `parseInput` (400). Only a RequestValidationError's message is echoed back as the
 * detail; any other parse failure returns a generic one.
 */
export function readIncidentWriteRequest<T>(
  event: IncidentEvent,
  deniedEvent: string,
  parseInput: (body: Record<string, unknown>) => T,
): IncidentWriteRequest<T> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const fail = (response: ProblemResponse): IncidentWriteRequest<T> => ({ ok: false, response });

  let deptId: VerifiedDeptId;
  try {
    ({ deptId } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: deniedEvent,
        correlationId: traceId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    return fail(
      problemResponse(
        401,
        'Unauthorized',
        'A valid department-scoped authorization context is required.',
        traceId,
      ),
    );
  }

  const incidentId = event.pathParameters?.incidentId;
  if (!incidentId) {
    return fail(
      problemResponse(400, 'Bad Request', 'incidentId path parameter is required.', traceId),
    );
  }
  try {
    assertNoDelimiter(incidentId, 'incidentId');
  } catch (error) {
    return fail(
      problemResponse(
        400,
        'Bad Request',
        error instanceof Error ? error.message : 'incidentId path parameter is invalid.',
        traceId,
      ),
    );
  }

  let input: T;
  try {
    input = parseInput(parseJsonObjectBody(event));
  } catch (error) {
    return fail(
      problemResponse(
        400,
        'Bad Request',
        error instanceof RequestValidationError ? error.message : 'invalid request body',
        traceId,
      ),
    );
  }

  return { ok: true, traceId, deptId, incidentId, input };
}
