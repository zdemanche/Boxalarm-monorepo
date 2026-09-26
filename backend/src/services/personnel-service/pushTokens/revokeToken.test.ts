import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'mbr-102',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(memberId: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'DELETE /api/v1/personnel/members/{memberId}/push-tokens',
    rawPath: `/api/v1/personnel/members/${memberId}/push-tokens`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId },
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function mockAuthzPassthrough(): void {
  vi.doMock('@boxalarm/authz', async () => {
    const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
    return { ...actual, withAuthorization: (inner: unknown) => inner };
  });
}

describe('revokeToken handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });

  it('clears the PUSH entry (leaving other channels) and writes an outbox row (AC5 sign-out)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: {
            pk: 'DEPT#NICHOLS#MEMBER#mbr-102',
            sk: 'METADATA',
            contactChannels: [
              { channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true },
              { channel: 'SMS', token: '+15551234567', valid: true },
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
    mockAuthzPassthrough();

    const { handler } = await import('./revokeToken.js');
    const event = buildEvent('mbr-102');
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{ statusCode: number; body: string }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      memberId: 'mbr-102',
      channel: 'PUSH',
      revoked: true,
    });

    const transactCall = send.mock.calls[1]?.[0] as {
      input: { TransactItems: [{ Update: { ExpressionAttributeValues: { ':cc': unknown[] } } }] };
    };
    const contactChannels = transactCall.input.TransactItems[0].Update.ExpressionAttributeValues[
      ':cc'
    ] as { channel: string }[];
    expect(contactChannels).toHaveLength(1);
    expect(contactChannels[0]?.channel).toBe('SMS');
  });

  it('returns 404 problem+json when the MEMBER item is absent', async () => {
    const send = vi.fn().mockResolvedValue({ Item: undefined });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    mockAuthzPassthrough();

    const { handler } = await import('./revokeToken.js');
    const event = buildEvent('mbr-102');
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{ statusCode: number }>
    )(event, PRINCIPAL);

    expect(result.statusCode).toBe(404);
  });

  it('propagates (does not swallow) a non-conditional DynamoDB failure', async () => {
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
    mockAuthzPassthrough();

    const { handler } = await import('./revokeToken.js');
    const event = buildEvent('mbr-102');
    await expect(
      (handler as unknown as (e: GuardEvent, p: CedarPrincipalContext) => Promise<unknown>)(
        event,
        PRINCIPAL,
      ),
    ).rejects.toThrow('ProvisionedThroughputExceededException');
  });

  it('returns 403 without touching DynamoDB when the path member is not the caller', async () => {
    const send = vi.fn();
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));
    mockAuthzPassthrough();

    const { handler } = await import('./revokeToken.js');
    const event = buildEvent('mbr-someone-else');
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
