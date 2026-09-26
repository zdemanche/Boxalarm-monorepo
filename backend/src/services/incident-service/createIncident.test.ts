import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';
import type { CreateIncidentInput } from './entity.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  body: unknown,
  headers: Record<string, string> = {},
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/incidents',
    rawPath: '/api/v1/incidents',
    rawQueryString: '',
    headers,
    isBase64Encoded: false,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/api/v1/incidents',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'POST /api/v1/incidents',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const ADMIN_AUTH = { sub: 'MBR-0034', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };
const CHIEF_AUTH = { sub: 'MBR-0001', deptId: 'NICHOLS', 'cognito:groups': 'CHIEF' };
const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

const VALID_BODY = {
  dispatchNumber: '4471',
  epochSeconds: 1_798_000_000,
  nerisSchemaVersion: '2026.2',
  corePayload: { opaque: true },
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
};

describe('createIncident handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./repository.js');
    vi.restoreAllMocks();
  });

  it('returns 201 with NERIS-format incidentId equal to sourceDispatchId for ADMIN (AC3)', async () => {
    const createIncident = vi.fn().mockImplementation((_deptId, input) =>
      Promise.resolve({
        incidentId: 'NICHOLS-4471-1798000000',
        sourceDispatchId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        status: 'DRAFT',
        ...input,
      }),
    );
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return { ...actual, getIncidentRepository: () => ({ createIncident }) };
    });
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(ADMIN_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.incidentId).toBe('NICHOLS-4471-1798000000');
    expect(body.sourceDispatchId).toBe(body.incidentId);
    expect(createIncident).toHaveBeenCalledWith(
      'NICHOLS',
      expect.objectContaining({
        dispatchNumber: '4471',
        epochSeconds: 1_798_000_000,
        nerisSchemaVersion: '2026.2',
        corePayload: { opaque: true },
        createdBy: 'MBR-0034',
        status: 'DRAFT',
      }),
      expect.any(Number),
      expect.any(String),
    );
  });

  it('uses the caller W3C traceparent header as the problem-body traceId (regression for PR #149 finding 3)', async () => {
    const { handler } = await import('./createIncident.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, VALID_BODY, {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }),
      {} as never,
      () => undefined,
    );

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('falls back to the API Gateway requestId when no traceparent header is sent', async () => {
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(MEMBER_AUTH, VALID_BODY), {} as never, () => undefined);

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.traceId).toBe('req-1');
  });

  it('returns 400 when corePayload serializes over the byte cap (regression for PR #149 finding 5)', async () => {
    const { handler } = await import('./createIncident.js');
    const oversizedCorePayload = { opaque: 'x'.repeat(400_000) };

    const result = await handler(
      buildEvent(ADMIN_AUTH, { ...VALID_BODY, corePayload: oversizedCorePayload }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.detail).toMatch(/corePayload must not exceed/);
  });

  it('returns 401 when the authorizer context has no sub (regression for PR #149 finding 4)', async () => {
    const { handler } = await import('./createIncident.js');

    const result = await handler(
      buildEvent({ deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' }, VALID_BODY),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('allows CHIEF to create an incident', async () => {
    const createIncident = vi.fn().mockResolvedValue({
      incidentId: 'NICHOLS-4471-1798000000',
      status: 'DRAFT',
    });
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return { ...actual, getIncidentRepository: () => ({ createIncident }) };
    });
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(CHIEF_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 201 });
  });

  it('never derives deptId from the request body (core-harm)', async () => {
    const createIncident = vi.fn().mockResolvedValue({ incidentId: 'NICHOLS-4471-1798000000' });
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return { ...actual, getIncidentRepository: () => ({ createIncident }) };
    });
    const { handler } = await import('./createIncident.js');

    await handler(
      buildEvent(ADMIN_AUTH, { ...VALID_BODY, deptId: 'FORGED-DEPT' }),
      {} as never,
      () => undefined,
    );

    expect(createIncident).toHaveBeenCalledWith(
      'NICHOLS',
      expect.any(Object),
      expect.any(Number),
      expect.any(String),
    );
  });

  it('returns 403 for a non-admin caller', async () => {
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(MEMBER_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 401 when the authorizer context is missing', async () => {
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(undefined, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 400 when corePayload is missing', async () => {
    const { handler } = await import('./createIncident.js');
    const rest = Object.fromEntries(
      Object.entries(VALID_BODY).filter(([key]) => key !== 'corePayload'),
    );

    const result = await handler(buildEvent(ADMIN_AUTH, rest), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when status is an unknown enum value (AC4)', async () => {
    const { handler } = await import('./createIncident.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH, { ...VALID_BODY, status: 'OPEN' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 409 on duplicate incidentId', async () => {
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return {
        ...actual,
        getIncidentRepository: () => ({
          createIncident: vi
            .fn()
            .mockRejectedValue(new actual.DuplicateIncidentError('NICHOLS-4471-1798000000')),
        }),
      };
    });
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(ADMIN_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('pre-populates from the DISPATCH_ALERT_COPY projection when dispatchId is given (E6-S2 AC1/AC2)', async () => {
    const createIncident = vi
      .fn()
      .mockImplementation((_deptId: string, input: CreateIncidentInput) =>
        Promise.resolve({
          incidentId: input.incidentId,
          sourceDispatchId: input.incidentId,
          deptId: 'NICHOLS',
          status: 'DRAFT',
          ...input,
        }),
      );
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return {
        ...actual,
        getIncidentRepository: () => ({ createIncident }),
        getDocumentClient: () => ({}),
        getTableName: () => 'boxalarm-dev-incident',
      };
    });
    vi.doMock('./dispatchProjection.js', () => ({
      getDispatchAlertCopy: vi.fn().mockResolvedValue({
        dispatchId: 'NICHOLS-MANUAL-1798000000-abcd1234',
        deptId: 'NICHOLS',
        incidentType: 'STRUCTURE_FIRE',
        address: '123 Main St',
        crossStreets: 'Elm & 1st',
        narrative: 'Smoke showing',
        dispatchedAt: 1_798_000_000,
      }),
      queryIncidentResponseUnits: vi.fn().mockResolvedValue([{ unitId: 'E1' }]),
      queryRosterCopy: vi.fn().mockResolvedValue([{ memberId: 'MBR-0034' }]),
    }));
    vi.doMock('./schemaVersion/repository.js', () => ({
      createSchemaVersionRepository: () => ({
        getActiveSchemaVersion: vi.fn().mockResolvedValue({ version: '2026.2' }),
      }),
    }));
    const { handler } = await import('./createIncident.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH, { dispatchId: 'NICHOLS-MANUAL-1798000000-abcd1234' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({
      incidentId: 'NICHOLS-MANUAL-1798000000-abcd1234',
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      narrative: 'Smoke showing',
      nerisSchemaVersion: '2026.2',
      respondingUnits: [{ unitId: 'E1' }],
      respondingMembers: [{ memberId: 'MBR-0034' }],
    });
    const [, createIncidentInput] = createIncident.mock.calls[0] as [string, CreateIncidentInput];
    expect(createIncidentInput.incidentId).toBe('NICHOLS-MANUAL-1798000000-abcd1234');
    expect(createIncidentInput.corePayload).toMatchObject({
      address: '123 Main St',
      narrative: 'Smoke showing',
    });
    vi.doUnmock('./dispatchProjection.js');
    vi.doUnmock('./schemaVersion/repository.js');
  });

  it('returns 404 when no dispatch exists for the given dispatchId (E6-S2 AC3)', async () => {
    vi.doMock('./dispatchProjection.js', () => ({
      getDispatchAlertCopy: vi.fn().mockResolvedValue(undefined),
      queryIncidentResponseUnits: vi.fn(),
      queryRosterCopy: vi.fn(),
    }));
    vi.doMock('./schemaVersion/repository.js', () => ({
      createSchemaVersionRepository: () => ({
        getActiveSchemaVersion: vi.fn().mockResolvedValue({ version: '2026.2' }),
      }),
    }));
    const { handler } = await import('./createIncident.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH, { dispatchId: 'NICHOLS-MISSING' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 404 });
    vi.doUnmock('./dispatchProjection.js');
    vi.doUnmock('./schemaVersion/repository.js');
  });

  it('still returns 404 for a missing dispatch when the concurrent schema lookup fails', async () => {
    vi.doMock('./dispatchProjection.js', () => ({
      getDispatchAlertCopy: vi.fn().mockResolvedValue(undefined),
      queryIncidentResponseUnits: vi.fn(),
      queryRosterCopy: vi.fn(),
    }));
    vi.doMock('./schemaVersion/repository.js', () => ({
      createSchemaVersionRepository: () => ({
        getActiveSchemaVersion: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
      }),
    }));
    const { handler } = await import('./createIncident.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH, { dispatchId: 'NICHOLS-MISSING' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 404 });
    vi.doUnmock('./dispatchProjection.js');
    vi.doUnmock('./schemaVersion/repository.js');
  });

  it('starts the active-schema lookup without waiting for the dispatch-copy read', async () => {
    let copyResolved = false;
    let schemaStartedBeforeCopyResolved: boolean | undefined;
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return {
        ...actual,
        getIncidentRepository: () => ({
          createIncident: (_deptId: string, input: CreateIncidentInput) =>
            Promise.resolve({ ...input, sourceDispatchId: input.incidentId }),
        }),
        getDocumentClient: () => ({}),
        getTableName: () => 'boxalarm-dev-incident',
      };
    });
    vi.doMock('./dispatchProjection.js', () => ({
      getDispatchAlertCopy: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            copyResolved = true;
            resolve({
              dispatchId: 'D-1',
              deptId: 'NICHOLS',
              incidentType: 'STRUCTURE_FIRE',
              address: '123 Main St',
              crossStreets: '',
              narrative: 'n',
              dispatchedAt: 1_798_000_000,
            });
          }, 10),
        ),
      queryIncidentResponseUnits: vi.fn().mockResolvedValue([]),
      queryRosterCopy: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('./schemaVersion/repository.js', () => ({
      createSchemaVersionRepository: () => ({
        getActiveSchemaVersion: () => {
          schemaStartedBeforeCopyResolved = !copyResolved;
          return Promise.resolve({ version: '2026.2' });
        },
      }),
    }));
    const { handler } = await import('./createIncident.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH, { dispatchId: 'D-1' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 201 });
    expect(schemaStartedBeforeCopyResolved).toBe(true);
    vi.doUnmock('./dispatchProjection.js');
    vi.doUnmock('./schemaVersion/repository.js');
  });

  it('returns 503 when DynamoDB is unavailable', async () => {
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return {
        ...actual,
        getIncidentRepository: () => ({
          createIncident: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
        }),
      };
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(ADMIN_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
