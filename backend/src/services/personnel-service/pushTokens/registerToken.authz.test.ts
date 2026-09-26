import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const send = vi.fn();

vi.mock('@aws-sdk/client-verifiedpermissions', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-verifiedpermissions')>(
    '@aws-sdk/client-verifiedpermissions',
  );
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send })),
  };
});

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

describe('registerToken real withAuthorization wiring (P5 regression)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    send.mockReset();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sends the correct actionType/actionId/resourceType/resourceId to Verified Permissions', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { pk: 'DEPT#NICHOLS#MEMBER#mbr-102', sk: 'METADATA' } });
      }
      return Promise.resolve({});
    });
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send: dynamoSend }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    const result = (await handler(event)) as { statusCode: number };

    expect(result.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const vpCall = send.mock.calls[0]?.[0] as {
      input: {
        action: { actionType: string; actionId: string };
        resource: { entityType: string; entityId: string };
      };
    };
    expect(vpCall.input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'RegisterPushToken',
    });
    expect(vpCall.input.resource).toEqual({ entityType: 'Boxalarm::Member', entityId: 'mbr-102' });

    vi.doUnmock('../dynamoClient.js');
  });

  it('returns 403 and never invokes the inner handler when Verified Permissions denies (real guard)', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const dynamoSend = vi.fn();
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send: dynamoSend }) as unknown as DynamoDBDocumentClient,
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));

    const { handler } = await import('./registerToken.js');
    const event = buildEvent('mbr-102', { platform: 'APNS', token: 'tok-abc' });
    const result = (await handler(event)) as { statusCode: number };

    expect(result.statusCode).toBe(403);
    expect(dynamoSend).not.toHaveBeenCalled();

    vi.doUnmock('../dynamoClient.js');
  });
});
