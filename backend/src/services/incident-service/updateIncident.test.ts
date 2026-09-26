import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';
import { CORE_SCHEMA_V_N, CORE_SCHEMA_V_N_MINUS_1 } from './schemaVersion/fixtures.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  body: unknown,
  pathParameters: Record<string, string> = { incidentId: 'NICHOLS-4471-1798000000' },
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/incidents/{incidentId}',
    rawPath: '/api/v1/incidents/NICHOLS-4471-1798000000',
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
        path: '/api/v1/incidents/NICHOLS-4471-1798000000',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'PUT /api/v1/incidents/{incidentId}',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

const BASE_INCIDENT = {
  incidentId: 'NICHOLS-4471-1798000000',
  deptId: 'NICHOLS',
  dispatchNumber: '4471',
  epochSeconds: 1_798_000_000,
  nerisSchemaVersion: '2026.2',
  corePayload: {},
  status: 'DRAFT',
  createdBy: 'MBR-0034',
};

function mockDeps(overrides: {
  readonly getIncident?: ReturnType<typeof vi.fn>;
  readonly updateCorePayload?: ReturnType<typeof vi.fn>;
  readonly activeSchema?: unknown;
  readonly getSchemaVersion?: ReturnType<typeof vi.fn>;
  readonly getCoreSchemaDocument?: ReturnType<typeof vi.fn>;
}): void {
  vi.doMock('./repository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./repository.js')>();
    return {
      ...actual,
      getIncidentRepository: () => ({
        getIncident: overrides.getIncident ?? vi.fn().mockResolvedValue(BASE_INCIDENT),
        updateCorePayload:
          overrides.updateCorePayload ??
          vi.fn().mockResolvedValue({ ...BASE_INCIDENT, status: 'VALIDATED' }),
      }),
      getDocumentClient: () => ({}),
      getTableName: () => 'boxalarm-dev-incident',
    };
  });
  vi.doMock('./schemaVersion/repository.js', () => ({
    createSchemaVersionRepository: () => ({
      getActiveSchemaVersion: vi
        .fn()
        .mockResolvedValue(
          overrides.activeSchema === undefined
            ? { version: '2026.2', coreSchemaS3Key: 'neris-schema/2026.2/core.json' }
            : overrides.activeSchema,
        ),
      getSchemaVersion:
        overrides.getSchemaVersion ??
        vi.fn().mockResolvedValue({
          version: '2026.2',
          coreSchemaS3Key: 'neris-schema/2026.2/core.json',
        }),
    }),
  }));
  vi.doMock('./schemaVersion/s3Schema.js', () => ({
    getCoreSchemaDocument:
      overrides.getCoreSchemaDocument ?? vi.fn().mockResolvedValue(CORE_SCHEMA_V_N),
  }));
  vi.doMock('../platform-service/export/awsClients.js', () => ({
    getS3Client: () => ({}),
  }));
}

describe('updateIncident handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('./repository.js');
    vi.doUnmock('./schemaVersion/repository.js');
    vi.doUnmock('./schemaVersion/s3Schema.js');
    vi.doUnmock('../platform-service/export/awsClients.js');
    vi.restoreAllMocks();
  });

  it('blocks with the specific invalid field and its allowed values (AC1)', async () => {
    mockDeps({});
    const { handler } = await import('./updateIncident.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { fields: { incident_type: 'NOT_A_TYPE' } }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as {
      errors: { field: string; message: string }[];
    };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.field).toBe('incident_type');
    expect(body.errors[0]?.message).toMatch(/must be one of/);
  });

  it('sets status to VALIDATED once all required Core fields are valid (AC2)', async () => {
    const updateCorePayload = vi.fn().mockResolvedValue({ ...BASE_INCIDENT, status: 'VALIDATED' });
    mockDeps({ updateCorePayload });
    const { handler } = await import('./updateIncident.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, {
        fields: { incident_type: 'STRUCTURE_FIRE', action_taken: 'EXTINGUISH' },
      }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(updateCorePayload).toHaveBeenCalledWith(
      'NICHOLS',
      'NICHOLS-4471-1798000000',
      { incident_type: 'STRUCTURE_FIRE', action_taken: 'EXTINGUISH' },
      'VALIDATED',
      expect.any(Number),
      'req-1',
    );
  });

  it('leaves status unchanged while required fields remain missing', async () => {
    const updateCorePayload = vi.fn().mockResolvedValue({ ...BASE_INCIDENT, status: 'DRAFT' });
    mockDeps({ updateCorePayload });
    const { handler } = await import('./updateIncident.js');

    await handler(
      buildEvent(MEMBER_AUTH, { fields: { incident_type: 'STRUCTURE_FIRE' } }),
      {} as never,
      () => undefined,
    );

    expect(updateCorePayload).toHaveBeenCalledWith(
      'NICHOLS',
      'NICHOLS-4471-1798000000',
      expect.any(Object),
      'DRAFT',
      expect.any(Number),
      'req-1',
    );
  });

  it(
    'validates an older incident against its own pinned (SUPERSEDED) schema version, not the ' +
      'newer ACTIVE schema (regression for PR #316 CRITICAL finding)',
    async () => {
      const olderIncident = { ...BASE_INCIDENT, nerisSchemaVersion: '2026.1' };
      const getSchemaVersion = vi.fn().mockImplementation((version: string) =>
        Promise.resolve(
          version === '2026.1'
            ? {
                version: '2026.1',
                status: 'SUPERSEDED',
                coreSchemaS3Key: 'neris-schema/2026.1/core.json',
              }
            : undefined,
        ),
      );
      const getCoreSchemaDocument = vi
        .fn()
        .mockImplementation((_s3: unknown, _bucket: unknown, key: string) =>
          Promise.resolve(
            key === 'neris-schema/2026.1/core.json' ? CORE_SCHEMA_V_N_MINUS_1 : CORE_SCHEMA_V_N,
          ),
        );
      mockDeps({
        getIncident: vi.fn().mockResolvedValue(olderIncident),
        // ACTIVE has moved on to 2026.2, which added FALSE_ALARM as a valid incident_type.
        activeSchema: { version: '2026.2', coreSchemaS3Key: 'neris-schema/2026.2/core.json' },
        getSchemaVersion,
        getCoreSchemaDocument,
      });
      const { handler } = await import('./updateIncident.js');

      // FALSE_ALARM is valid under the newer ACTIVE (2026.2) schema but NOT under this
      // incident's own pinned 2026.1 schema — proving it validates against the pinned
      // version, not whatever is ACTIVE now.
      const result = await handler(
        buildEvent(MEMBER_AUTH, {
          fields: { incident_type: 'FALSE_ALARM', action_taken: 'EXTINGUISH' },
        }),
        {} as never,
        () => undefined,
      );

      expect(getSchemaVersion).toHaveBeenCalledWith('2026.1');
      expect(result).toMatchObject({ statusCode: 400 });
      const body = JSON.parse((result as { body: string }).body) as {
        errors: { field: string; message: string }[];
      };
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]?.field).toBe('incident_type');
    },
  );

  it('falls back to the ACTIVE schema when the pinned version cannot be resolved (e.g. the UNVALIDATED sentinel)', async () => {
    const unvalidatedIncident = { ...BASE_INCIDENT, nerisSchemaVersion: 'UNVALIDATED' };
    const getSchemaVersion = vi.fn().mockResolvedValue(undefined);
    const updateCorePayload = vi.fn().mockResolvedValue({ ...BASE_INCIDENT, status: 'VALIDATED' });
    mockDeps({
      getIncident: vi.fn().mockResolvedValue(unvalidatedIncident),
      updateCorePayload,
      getSchemaVersion,
    });
    const { handler } = await import('./updateIncident.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, {
        fields: { incident_type: 'STRUCTURE_FIRE', action_taken: 'EXTINGUISH' },
      }),
      {} as never,
      () => undefined,
    );

    expect(getSchemaVersion).toHaveBeenCalledWith('UNVALIDATED');
    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 404 when the incident does not exist', async () => {
    mockDeps({ getIncident: vi.fn().mockResolvedValue(undefined) });
    const { handler } = await import('./updateIncident.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { fields: { incident_type: 'STRUCTURE_FIRE' } }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 when fields is missing', async () => {
    mockDeps({});
    const { handler } = await import('./updateIncident.js');

    const result = await handler(buildEvent(MEMBER_AUTH, {}), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 401 when unauthorized', async () => {
    mockDeps({});
    const { handler } = await import('./updateIncident.js');

    const result = await handler(
      buildEvent(undefined, { fields: {} }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });
});
