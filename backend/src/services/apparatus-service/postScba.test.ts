import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'dept-001',
  'cognito:groups': 'apparatus',
};

function buildEvent(
  body: string | undefined,
  unitId: string | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/{unitId}/scba',
    rawPath: `/api/v1/apparatus/${unitId ?? ''}/scba`,
    rawQueryString: '',
    headers,
    pathParameters: unitId !== undefined ? { unitId } : undefined,
    body,
    requestContext: {
      authorizer: { lambda: principal ?? undefined },
    },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY' | Error = 'ALLOW'): VerifiedPermissionsClient {
  return {
    send:
      decision instanceof Error
        ? vi.fn().mockRejectedValue(decision)
        : vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function fakeDynamoClient(options: {
  readonly apparatusExists: boolean;
  readonly transactError?: Error;
}): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      return Promise.resolve(
        options.apparatusExists
          ? {
              Items: [
                {
                  apparatusId: 'APP-ENGINE-2',
                  unitId: 'ENGINE-2',
                  type: 'ENGINE',
                  status: 'IN_SERVICE',
                },
              ],
            }
          : { Items: [] },
      );
    }
    if (command instanceof TransactWriteCommand) {
      return options.transactError ? Promise.reject(options.transactError) : Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

function findTransactItems(
  client: DynamoDBDocumentClient,
): { readonly Put: { readonly Item: Record<string, unknown> } }[] {
  const call = (client.send as ReturnType<typeof vi.fn>).mock.calls.find(
    (call: unknown[]) => call[0] instanceof TransactWriteCommand,
  ) as [TransactWriteCommand] | undefined;
  return (call?.[0].input.TransactItems ?? []) as {
    readonly Put: { readonly Item: Record<string, unknown> };
  }[];
}

const VALID_BODY = JSON.stringify({
  scbaUnitId: 'SCBA-001',
  cylinderId: 'CYL-0891',
  flowTestDate: '2026-01-01',
  hydroTestDate: '2026-06-01',
});

async function importHandler() {
  const { createPostScbaHandler } = await import('./postScba.js');
  return createPostScbaHandler;
}

describe('postScba handler', () => {
  it('returns 401 (fail-closed) when the bearer token is missing', async () => {
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent('{}', 'ENGINE-2', PRINCIPAL, {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 forbidden on a Cedar deny', async () => {
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('DENY'),
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 fail-closed when Verified Permissions is unavailable', async () => {
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient(new Error('VP outage')),
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 404 apparatus-not-found when the parent apparatus does not exist (E4-S1 dependency)', async () => {
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: false }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 validation-error with a field-level errors array when required fields are missing', async () => {
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent('{}', 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { errors: unknown[] };
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('returns 400 when scbaUnitId contains the "#" dept-scope delimiter', async () => {
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const body = JSON.stringify({
      scbaUnitId: 'SCBA#001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-06-01',
    });
    const result = await handler(buildEvent(body, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when flowTestDate/hydroTestDate are malformed, but accepts a future date', async () => {
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const malformed = JSON.stringify({
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: 'not-a-date',
      hydroTestDate: '2026-06-01',
    });
    const result = await handler(buildEvent(malformed, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });

    const future = JSON.stringify({
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2099-01-01',
      hydroTestDate: '2099-06-01',
    });
    const futureResult = await handler(buildEvent(future, 'ENGINE-2'));
    expect(futureResult).toMatchObject({ statusCode: 201 });
  });

  it('returns 400 validation-error on an empty body', async () => {
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent(undefined, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 and logs the original parse error on malformed JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent('{not json', 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MalformedJson'));
    errorSpy.mockRestore();
  });

  it('propagates (does not swallow) a TransactWriteItems failure, logging the original error first', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const transactError = new Error('table throttled');
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({ apparatusExists: true, transactError }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    await expect(handler(buildEvent(VALID_BODY, 'ENGINE-2'))).rejects.toThrow('table throttled');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('table throttled'));
    errorSpy.mockRestore();
  });

  it('emits a ScbaCreateFailed business metric before rethrowing a TransactWriteItems failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: fakeDynamoClient({
        apparatusExists: true,
        transactError: new Error('table throttled'),
      }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    await expect(handler(buildEvent(VALID_BODY, 'ENGINE-2'))).rejects.toThrow('table throttled');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ScbaCreateFailed'));
  });

  it('writes a METADATA item with the computed next-due dates and a TEST audit row, emits ScbaCreated (AC1)', async () => {
    const dynamoClient = fakeDynamoClient({ apparatusExists: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const createPostScbaHandler = await importHandler();
    const handler = createPostScbaHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 201 });
    const [metadataPut, testPut] = findTransactItems(dynamoClient);
    expect(metadataPut?.Put.Item.entityType).toBe('SCBA_RECORD');
    expect(metadataPut?.Put.Item.pk).toBe('DEPT#dept-001#SCBA#SCBA-001');
    // The path carries the display unitId; the stored record carries the resolved apparatusId.
    expect(metadataPut?.Put.Item.apparatusId).toBe('APP-ENGINE-2');
    expect(testPut?.Put.Item.apparatusId).toBe('APP-ENGINE-2');
    expect(metadataPut?.Put.Item.nextFlowTestDue).toBe('2027-01-01');
    expect(metadataPut?.Put.Item.nextHydroTestDue).toBe('2031-05-31');
    expect(testPut?.Put.Item.entityType).toBe('SCBA_TEST');
    expect(testPut?.Put.Item.sk).toBe('TEST#2026-01-01');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ScbaCreated'));

    const body = JSON.parse((result as { body: string }).body) as {
      nextFlowTestDue: string;
      nextHydroTestDue: string;
    };
    expect(body.nextFlowTestDue).toBe('2027-01-01');
    expect(body.nextHydroTestDue).toBe('2031-05-31');
  });

  it('never shares a pk/gsi2pk between two principals in different departments for the same scbaUnitId (core-harm)', async () => {
    const createPostScbaHandler = await importHandler();

    const clientA = fakeDynamoClient({ apparatusExists: true });
    const handlerA = createPostScbaHandler({
      client: clientA,
      authzClient: fakeAuthzClient('ALLOW'),
    });
    await handlerA(
      buildEvent(VALID_BODY, 'ENGINE-2', {
        sub: 'a',
        deptId: 'dept-a',
        'cognito:groups': 'apparatus',
      }),
    );

    const clientB = fakeDynamoClient({ apparatusExists: true });
    const handlerB = createPostScbaHandler({
      client: clientB,
      authzClient: fakeAuthzClient('ALLOW'),
    });
    await handlerB(
      buildEvent(VALID_BODY, 'ENGINE-2', {
        sub: 'b',
        deptId: 'dept-b',
        'cognito:groups': 'apparatus',
      }),
    );

    const [itemA, , flowDueItemA] = findTransactItems(clientA);
    const [itemB, , flowDueItemB] = findTransactItems(clientB);

    expect(itemA?.Put.Item.pk).not.toBe(itemB?.Put.Item.pk);
    expect(flowDueItemA?.Put.Item.gsi2pk).not.toBe(flowDueItemB?.Put.Item.gsi2pk);
  });
});
