import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'mbr-102',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(memberId: string, body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/personnel/members/{memberId}/push-tokens',
    rawPath: `/api/v1/personnel/members/${memberId}/push-tokens`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId },
    body: JSON.stringify(body),
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

describe('parseRegisterBody', () => {
  it('throws when token is absent', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(() => parseRegisterBody(JSON.stringify({ platform: 'APNS' }))).toThrow(
      'token is required',
    );
  });

  it('throws when token is an empty string', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(() => parseRegisterBody(JSON.stringify({ platform: 'APNS', token: '' }))).toThrow(
      'token is required',
    );
  });

  it('throws when platform is wrong-typed (a number)', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(() => parseRegisterBody(JSON.stringify({ platform: 1, token: 'tok' }))).toThrow(
      'platform is required',
    );
  });

  it('parses a valid body', async () => {
    const { parseRegisterBody } = await import('./registerToken.js');
    expect(parseRegisterBody(JSON.stringify({ platform: 'FCM', token: 'tok-1' }))).toEqual({
      platform: 'FCM',
      token: 'tok-1',
    });
  });
});

describe('registerToken handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 400 problem+json when body.token is absent/empty (AC-matrix)', async () => {
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return {
        ...actual,
        withAuthorization: (inner: unknown) => inner,
      };
    });
    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{
        statusCode: number;
      }>
    )(event, PRINCIPAL);
    expect(result.statusCode).toBe(400);
    vi.doUnmock('@boxalarm/authz');
  });

  it('registers a token and writes MEMBER + OUTBOX_ENTRY via one TransactWriteItems call (AC1)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'DEPT#NICHOLS#MEMBER#mbr-102', sk: 'METADATA' } });
      }
      return Promise.resolve({});
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{
        statusCode: number;
      }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    const transactCall = send.mock.calls[1]?.[0] as {
      input: { TransactItems: [{ Update: unknown }, { Put: { Item: Record<string, unknown> } }] };
    };
    expect(transactCall.input.TransactItems).toHaveLength(2);
    const outboxItem = transactCall.input.TransactItems[1].Put.Item;
    expect(outboxItem.eventType).toBe('personnel.member.updated');
    expect(outboxItem.pk).toBe('DEPT#NICHOLS#OUTBOX#mbr-102');

    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('returns 404 problem+json when the MEMBER item is absent (AC-matrix)', async () => {
    const send = vi.fn().mockResolvedValue({ Item: undefined });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{
        statusCode: number;
      }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(404);
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('propagates (does not swallow) a DynamoDB TransactWriteItems throw that is not a conditional-check failure (AC-matrix)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'DEPT#NICHOLS#MEMBER#mbr-102', sk: 'METADATA' } });
      }
      return Promise.reject(new Error('ProvisionedThroughputExceededException'));
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    await expect(
      (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
        event,
        PRINCIPAL,
      ),
    ).rejects.toThrow('ProvisionedThroughputExceededException');

    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('rethrows (does not map to 404) a TransactionCanceledException whose cancellation reason is not ConditionalCheckFailed (P12 regression)', async () => {
    const { TransactionCanceledException } = await import('@aws-sdk/client-dynamodb');
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'DEPT#NICHOLS#MEMBER#mbr-102', sk: 'METADATA' } });
      }
      return Promise.reject(
        new TransactionCanceledException({
          message: 'cancelled',
          CancellationReasons: [{ Code: 'TransactionConflict' }],
          $metadata: {},
        }),
      );
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    await expect(
      (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
        event,
        PRINCIPAL,
      ),
    ).rejects.toThrow('cancelled');

    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('rotates: a second register call overwrites the stale token, never appending a duplicate PUSH entry (AC2)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: {
            pk: 'DEPT#NICHOLS#MEMBER#mbr-102',
            sk: 'METADATA',
            contactChannels: [
              { channel: 'PUSH', platform: 'APNS', token: 'stale-tok', valid: true },
            ],
          },
        });
      }
      return Promise.resolve({});
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'FCM', token: 'fresh-tok' });
    await (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
      event,
      PRINCIPAL,
    );

    const transactCall = send.mock.calls[1]?.[0] as {
      input: { TransactItems: [{ Update: { ExpressionAttributeValues: { ':cc': unknown[] } } }] };
    };
    const contactChannels = transactCall.input.TransactItems[0].Update.ExpressionAttributeValues[
      ':cc'
    ] as { token: string }[];
    expect(contactChannels).toHaveLength(1);
    expect(contactChannels[0]?.token).toBe('fresh-tok');

    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('never logs the raw token value', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'DEPT#NICHOLS#MEMBER#mbr-102', sk: 'METADATA' } });
      }
      return Promise.resolve({});
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const secretToken = 'super-secret-device-token-value';
    const event = buildEvent('mbr-102', { platform: 'APNS', token: secretToken });
    await (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
      event,
      PRINCIPAL,
    );

    for (const call of logSpy.mock.calls) {
      expect(call[0] as string).not.toContain(secretToken);
    }

    logSpy.mockRestore();
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('returns 403 without touching DynamoDB when the path member is not the caller', async () => {
    const send = vi.fn();
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-someone-else', { platform: 'APNS', token: 'tok-abc' });
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{ statusCode: number }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });
});
