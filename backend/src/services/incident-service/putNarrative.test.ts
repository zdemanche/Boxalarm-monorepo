import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  body: unknown,
  pathParameters: Record<string, string> = { incidentId: 'NICHOLS-4471-1798000000' },
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/incidents/{incidentId}/narrative',
    rawPath: '/api/v1/incidents/NICHOLS-4471-1798000000/narrative',
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
        path: '/api/v1/incidents/NICHOLS-4471-1798000000/narrative',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'PUT /api/v1/incidents/{incidentId}/narrative',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

describe('putNarrative handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./repository.js');
    vi.restoreAllMocks();
  });

  it('returns the incident with the narrative unchanged on read-back (AC1)', async () => {
    const updateNarrative = vi.fn().mockResolvedValue({
      incidentId: 'NICHOLS-4471-1798000000',
      narrative: 'Smoke showing from second floor, extinguished.',
      status: 'DRAFT',
    });
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return { ...actual, getIncidentRepository: () => ({ updateNarrative }) };
    });
    const { handler } = await import('./putNarrative.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { narrative: 'Smoke showing from second floor, extinguished.' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.narrative).toBe('Smoke showing from second floor, extinguished.');
    expect(updateNarrative).toHaveBeenCalledWith(
      'NICHOLS',
      'NICHOLS-4471-1798000000',
      'Smoke showing from second floor, extinguished.',
      expect.any(Number),
      'req-1',
    );
  });

  it('returns 400 with a length-limit error rather than truncating (AC2)', async () => {
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return {
        ...actual,
        getIncidentRepository: () => ({
          updateNarrative: vi.fn().mockRejectedValue(new actual.NarrativeTooLongError(30_000)),
        }),
      };
    });
    const { handler } = await import('./putNarrative.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { narrative: 'x'.repeat(30_000) }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.detail).toMatch(/must not exceed/);
  });

  it('returns 404 when the incident does not exist', async () => {
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return {
        ...actual,
        getIncidentRepository: () => ({
          updateNarrative: vi
            .fn()
            .mockRejectedValue(new actual.IncidentNotFoundError('NICHOLS-4471-1798000000')),
        }),
      };
    });
    const { handler } = await import('./putNarrative.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { narrative: 'test' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 when narrative is missing', async () => {
    const { handler } = await import('./putNarrative.js');

    const result = await handler(buildEvent(MEMBER_AUTH, {}), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 401 when unauthorized', async () => {
    const { handler } = await import('./putNarrative.js');

    const result = await handler(
      buildEvent(undefined, { narrative: 'test' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });
});
