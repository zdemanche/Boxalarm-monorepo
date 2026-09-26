import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';
import { SECONDARY_SCHEMA_V_N, SECONDARY_SCHEMA_V_N_MINUS_1 } from './schemaVersion/fixtures.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  body: unknown,
  pathParameters: Record<string, string> = { incidentId: 'NICHOLS-4471-1798000000' },
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/incidents/{incidentId}/exposures',
    rawPath: '/api/v1/incidents/NICHOLS-4471-1798000000/exposures',
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
        path: '/api/v1/incidents/NICHOLS-4471-1798000000/exposures',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'PUT /api/v1/incidents/{incidentId}/exposures',
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

function mockDeps(
  overrides: {
    readonly putIncidentSecondary?: ReturnType<typeof vi.fn>;
    readonly getIncident?: ReturnType<typeof vi.fn>;
    readonly getSchemaVersion?: ReturnType<typeof vi.fn>;
    readonly getSecondarySchemaDocument?: ReturnType<typeof vi.fn>;
  } = {},
): void {
  process.env.INCIDENT_TABLE_NAME = 'boxalarm-dev-incident';
  vi.doMock('./repository.js', () => ({
    getDocumentClient: () => ({}),
    getTableName: () => 'boxalarm-dev-incident',
    getIncidentRepository: () => ({
      getIncident: overrides.getIncident ?? vi.fn().mockResolvedValue(BASE_INCIDENT),
    }),
  }));
  vi.doMock('./secondaryRepository.js', () => ({
    putIncidentSecondary: overrides.putIncidentSecondary ?? vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('./schemaVersion/repository.js', () => ({
    createSchemaVersionRepository: () => ({
      getActiveSchemaVersion: vi.fn().mockResolvedValue({
        version: '2026.2',
        secondarySchemaS3Key: 'neris-schema/2026.2/secondary.json',
      }),
      getSchemaVersion:
        overrides.getSchemaVersion ??
        vi.fn().mockResolvedValue({
          version: '2026.2',
          secondarySchemaS3Key: 'neris-schema/2026.2/secondary.json',
        }),
    }),
  }));
  vi.doMock('./schemaVersion/s3Schema.js', () => ({
    getSecondarySchemaDocument:
      overrides.getSecondarySchemaDocument ?? vi.fn().mockResolvedValue(SECONDARY_SCHEMA_V_N),
  }));
  vi.doMock('../platform-service/export/awsClients.js', () => ({ getS3Client: () => ({}) }));
}

describe('putExposures handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('./repository.js');
    vi.doUnmock('./secondaryRepository.js');
    vi.doUnmock('./schemaVersion/repository.js');
    vi.doUnmock('./schemaVersion/s3Schema.js');
    vi.doUnmock('../platform-service/export/awsClients.js');
    vi.restoreAllMocks();
  });

  it('creates an INCIDENT_SECONDARY record naming the affected members (E6-S6 AC1)', async () => {
    const putIncidentSecondary = vi.fn().mockResolvedValue(undefined);
    mockDeps({ putIncidentSecondary });
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, {
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['MBR-0034'],
      }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(putIncidentSecondary).toHaveBeenCalledWith(
      expect.anything(),
      'boxalarm-dev-incident',
      'NICHOLS',
      expect.objectContaining({ secondaryType: 'EXPOSURE', affectedMemberIds: ['MBR-0034'] }),
      'req-1',
    );
  });

  it('rejects a value outside the Secondary schema enumeration before completion (AC2)', async () => {
    mockDeps();
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, {
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'RADIATION' },
        affectedMemberIds: ['MBR-0034'],
      }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as {
      errors: { field: string; message: string }[];
    };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.field).toBe('exposure_type');
    expect(body.errors[0]?.message).toMatch(/must be one of/);
  });

  it(
    'validates an older incident against its own pinned (SUPERSEDED) Secondary schema version, ' +
      'not the newer ACTIVE schema (regression for PR #316 CRITICAL finding)',
    async () => {
      const olderIncident = { ...BASE_INCIDENT, nerisSchemaVersion: '2026.1' };
      const getSchemaVersion = vi.fn().mockImplementation((version: string) =>
        Promise.resolve(
          version === '2026.1'
            ? {
                version: '2026.1',
                status: 'SUPERSEDED',
                secondarySchemaS3Key: 'neris-schema/2026.1/secondary.json',
              }
            : undefined,
        ),
      );
      const getSecondarySchemaDocument = vi
        .fn()
        .mockImplementation((_s3: unknown, _bucket: unknown, key: string) =>
          Promise.resolve(
            key === 'neris-schema/2026.1/secondary.json'
              ? SECONDARY_SCHEMA_V_N_MINUS_1
              : SECONDARY_SCHEMA_V_N,
          ),
        );
      mockDeps({
        getIncident: vi.fn().mockResolvedValue(olderIncident),
        getSchemaVersion,
        getSecondarySchemaDocument,
      });
      const { handler } = await import('./putExposures.js');

      // BLOODBORNE is valid under the newer ACTIVE (2026.2) Secondary schema but NOT under
      // this incident's own pinned 2026.1 schema — proving it validates against the pinned
      // version, not whatever is ACTIVE now.
      const result = await handler(
        buildEvent(MEMBER_AUTH, {
          secondaryType: 'EXPOSURE',
          payload: { exposure_type: 'BLOODBORNE' },
          affectedMemberIds: ['MBR-0034'],
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
      expect(body.errors[0]?.field).toBe('exposure_type');
    },
  );

  it('returns 404 when the incident does not exist', async () => {
    mockDeps({ getIncident: vi.fn().mockResolvedValue(undefined) });
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, {
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['MBR-0034'],
      }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 when affectedMemberIds is missing', async () => {
    mockDeps();
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { secondaryType: 'EXPOSURE', payload: {} }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 401 when unauthorized', async () => {
    mockDeps();
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(undefined, { secondaryType: 'EXPOSURE', payload: {}, affectedMemberIds: [] }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });
});
