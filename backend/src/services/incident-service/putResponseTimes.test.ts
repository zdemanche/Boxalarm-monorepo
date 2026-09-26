import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  body: unknown,
  pathParameters: Record<string, string> = { incidentId: 'NICHOLS-4471-1798000000' },
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/incidents/{incidentId}/response-times',
    rawPath: '/api/v1/incidents/NICHOLS-4471-1798000000/response-times',
    rawQueryString: '',
    headers: {},
    pathParameters,
    isBase64Encoded: false,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'PUT',
        path: '/api/v1/incidents/NICHOLS-4471-1798000000/response-times',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'PUT /api/v1/incidents/{incidentId}/response-times',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

describe('putResponseTimes handler', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.INCIDENT_TABLE_NAME = 'boxalarm-dev-incident';
  });

  afterEach(() => {
    vi.doUnmock('./responseUnitRepository.js');
    vi.restoreAllMocks();
  });

  it('records each timestamp independently for the given unit (AC1)', async () => {
    const upsertResponseUnitTimes = vi.fn().mockResolvedValue({
      incidentId: 'NICHOLS-4471-1798000000',
      unitId: 'E1',
      unitType: 'APPARATUS',
      arrivedAt: 200,
    });
    vi.doMock('./responseUnitRepository.js', () => ({ upsertResponseUnitTimes }));
    const { handler } = await import('./putResponseTimes.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { unitId: 'E1', unitType: 'APPARATUS', arrivedAt: 200 }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(upsertResponseUnitTimes).toHaveBeenCalledWith(
      expect.anything(),
      'boxalarm-dev-incident',
      expect.objectContaining({
        deptId: 'NICHOLS',
        incidentId: 'NICHOLS-4471-1798000000',
        unitId: 'E1',
        unitType: 'APPARATUS',
        times: { arrivedAt: 200 },
      }),
      'req-1',
    );
  });

  it('returns 404 when the incident does not exist (regression for PR #316 MINOR finding)', async () => {
    // Imported dynamically (post vi.resetModules()) so this is the exact same module
    // instance putResponseTimes.ts's own `./repository.js` import resolves to — a static
    // top-of-file import would be a different instantiation and fail `instanceof`.
    const { IncidentNotFoundError } = await import('./repository.js');
    const upsertResponseUnitTimes = vi
      .fn()
      .mockRejectedValue(new IncidentNotFoundError('NICHOLS-9999'));
    vi.doMock('./responseUnitRepository.js', () => ({ upsertResponseUnitTimes }));
    const { handler } = await import('./putResponseTimes.js');

    const result = await handler(
      buildEvent(
        MEMBER_AUTH,
        { unitId: 'E1', unitType: 'APPARATUS', arrivedAt: 200 },
        { incidentId: 'NICHOLS-9999' },
      ),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 for an unknown unitType', async () => {
    const { handler } = await import('./putResponseTimes.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { unitId: 'E1', unitType: 'BOAT', arrivedAt: 1 }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when unitId is missing', async () => {
    const { handler } = await import('./putResponseTimes.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { unitType: 'APPARATUS' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 401 when unauthorized', async () => {
    const { handler } = await import('./putResponseTimes.js');

    const result = await handler(
      buildEvent(undefined, { unitId: 'E1', unitType: 'APPARATUS' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });
});
