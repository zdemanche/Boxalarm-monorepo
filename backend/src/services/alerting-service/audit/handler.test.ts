import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { GuardEvent } from '@boxalarm/authz';

const DEPT_ID = 'NICHOLS';
const ADMIN_PRINCIPAL = { sub: 'mbr-admin', deptId: DEPT_ID, 'cognito:groups': 'CHIEF' };

function buildEvent(
  queryStringParameters: Record<string, string> | undefined,
  options: {
    readonly headers?: Record<string, string> | undefined;
    readonly principal?: Record<string, unknown> | null;
  } = {},
): GuardEvent {
  const principal = options.principal === null ? undefined : (options.principal ?? ADMIN_PRINCIPAL);
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/audit',
    rawPath: '/api/v1/alerting/audit',
    rawQueryString: '',
    queryStringParameters,
    headers: 'headers' in options ? options.headers : { authorization: 'Bearer token' },
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

function mockAuthzDecision(decision: 'ALLOW' | 'DENY' | 'ERROR'): {
  send: ReturnType<typeof vi.fn>;
} {
  const send =
    decision === 'ERROR'
      ? vi.fn().mockRejectedValue(new Error('VP outage'))
      : vi
          .fn()
          .mockImplementation((command: { input: unknown }) =>
            Promise.resolve({ decision, __input: command.input }),
          );
  vi.doMock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
    return {
      ...actual,
      VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send })),
    };
  });
  return { send };
}

function mockDynamo(
  behavior: 'OK' | 'ERROR',
  items: unknown[] = [],
): { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  if (behavior === 'OK') {
    send.mockResolvedValue({ Items: items });
  } else {
    send.mockRejectedValue(new Error('DynamoDB unavailable'));
  }
  const client = { send };
  vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => client };
  });
  return client;
}

describe('handler (audit query entrypoint)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.doUnmock('../eligibility/dynamoClient.js');
  });

  it('returns 200 with entries for a memberId query (AC2)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK', [{ entityType: 'DELIVERY_RECEIPT', memberId: 'mbr-102' }]);
    const { handler } = await import('./handler.js');

    const result = (await handler(
      buildEvent({ memberId: 'mbr-102' }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? '{}')).toEqual({
      entries: [{ entityType: 'DELIVERY_RECEIPT', memberId: 'mbr-102' }],
    });
  });

  it('returns 200 with entries for a from/to date-range query (AC1/AC4)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK', []);
    const { handler } = await import('./handler.js');

    const result = (await handler(
      buildEvent({ from: '100', to: '200' }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ entries: [] });
  });

  it("authorizes another member's history as department audit data, not as the caller's own (AC5 IDOR guard)", async () => {
    const { send } = mockAuthzDecision('ALLOW');
    mockDynamo('OK', []);
    const { handler } = await import('./handler.js');

    await handler(
      buildEvent(
        { memberId: 'mbr-999' },
        { principal: { sub: 'mbr-102', deptId: DEPT_ID, 'cognito:groups': 'member' } },
      ),
    );

    const call = send.mock.calls[0]?.[0] as {
      input: {
        action?: { actionId?: string };
        resource?: { entityType?: string; entityId?: string };
      };
    };
    expect(call.input.action?.actionId).toBe('ViewAlertingAuditLog');
    expect(call.input.resource).toEqual({ entityType: 'Boxalarm::Department', entityId: DEPT_ID });
  });

  it("authorizes the caller's own history as ViewOwnDeliveryHistory on their member record", async () => {
    const { send } = mockAuthzDecision('ALLOW');
    mockDynamo('OK', []);
    const { handler } = await import('./handler.js');

    await handler(
      buildEvent(
        { memberId: 'mbr-102' },
        { principal: { sub: 'mbr-102', deptId: DEPT_ID, 'cognito:groups': 'member' } },
      ),
    );

    const call = send.mock.calls[0]?.[0] as {
      input: {
        action?: { actionId?: string };
        resource?: { entityType?: string; entityId?: string };
      };
    };
    expect(call.input.action?.actionId).toBe('ViewOwnDeliveryHistory');
    expect(call.input.resource).toEqual({ entityType: 'Boxalarm::Member', entityId: 'mbr-102' });
  });

  it('denies (fails closed) 403 when Cedar denies the action (AC5)', async () => {
    mockAuthzDecision('DENY');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ memberId: 'mbr-102' }));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('denies (fails closed) 403 for a non-admin querying another member (AC5)', async () => {
    mockAuthzDecision('DENY');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(
      buildEvent(
        { memberId: 'mbr-999' },
        { principal: { sub: 'mbr-102', deptId: DEPT_ID, 'cognito:groups': 'member' } },
      ),
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns 401 (fail-closed) when the request has no authenticated principal', async () => {
    mockAuthzDecision('ALLOW');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ memberId: 'mbr-102' }, { principal: null }));

    expect(result).toMatchObject({ statusCode: 401 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns 401 (fail-closed) when the request has no bearer token', async () => {
    mockAuthzDecision('ALLOW');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ memberId: 'mbr-102' }, { headers: {} }));

    expect(result).toMatchObject({ statusCode: 401 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('denies (fails closed) with 503, never a defaulted allow, when Verified Permissions is unavailable (core-harm)', async () => {
    mockAuthzDecision('ERROR');
    const client = mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ memberId: 'mbr-102' }));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns 400 when neither memberId nor from/to is present', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when from is non-numeric or from > to', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const nonNumeric = await handler(buildEvent({ from: 'abc', to: '200' }));
    const outOfOrder = await handler(buildEvent({ from: '300', to: '200' }));

    expect(nonNumeric).toMatchObject({ statusCode: 400 });
    expect(outOfOrder).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 on a malformed cursor', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ memberId: 'mbr-102', cursor: '!!!not-valid' }));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 503 (fail-closed) when DynamoDB is unavailable mid-query', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('ERROR');
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ memberId: 'mbr-102' }));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('logs the original error before returning a problem response on a DynamoDB failure (error-path-logging)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('ERROR');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');

    await handler(buildEvent({ memberId: 'mbr-102' }));

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      message?: string;
      reason?: string;
    };
    expect(logged.message).toBeTruthy();
    expect(logged.reason).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('emits an AuditQuery business metric on success and on failure (business-metrics)', async () => {
    mockAuthzDecision('ALLOW');
    mockDynamo('OK');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');

    await handler(buildEvent({ memberId: 'mbr-102' }));

    expect(logSpy.mock.calls.some((call) => (call[0] as string).includes('AuditQueryServed'))).toBe(
      true,
    );
    logSpy.mockRestore();
  });
});
