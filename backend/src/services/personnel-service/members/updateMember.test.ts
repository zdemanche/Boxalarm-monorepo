import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent, CedarPrincipalContext } from '@boxalarm/authz';

const SELF: CedarPrincipalContext = {
  sub: 'mbr-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(
  memberId: string | undefined,
  body: string | undefined,
  headers: Record<string, string> | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/personnel/members/{memberId}',
    rawPath: `/api/v1/personnel/members/${memberId ?? ''}`,
    rawQueryString: '',
    headers,
    pathParameters: memberId ? { memberId } : undefined,
    body,
    requestContext: {
      authorizer: { lambda: principal ?? undefined },
    },
  } as unknown as GuardEvent;
}

function fakeVpClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function fakeDocClient(docSend: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send: docSend } as unknown as DynamoDBDocumentClient;
}

describe('updateMember handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('advances updatedAt and persists the self-edit (AC1)', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn().mockResolvedValue({});
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    const result = await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: '555-0100' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      memberId: string;
      updatedAt: number;
      phone: string;
    };
    expect(body.memberId).toBe('mbr-1');
    expect(body.phone).toBe('555-0100');
    expect(typeof body.updatedAt).toBe('number');

    const call = docSend.mock.calls[0]?.[0] as {
      input: {
        TransactItems: Array<{
          Update?: { Key: { pk: string; sk: string } };
          Put?: { Item: { pk: string; sk: string; entityType: string } };
        }>;
      };
    };
    const transactInput = call.input;
    expect(transactInput.TransactItems[0]?.Update?.Key).toEqual({
      pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
      sk: 'METADATA',
    });
    expect(transactInput.TransactItems[1]?.Put?.Item.pk).toBe('DEPT#NICHOLS#OUTBOX#mbr-1');
    expect(transactInput.TransactItems[1]?.Put?.Item.entityType).toBe('OUTBOX_ENTRY');
  });

  it('denies a cross-member edit with 403 before touching DynamoDB (AC2)', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn();
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('DENY'),
    });

    const result = await wrapped(
      buildEvent(
        'mbr-2',
        JSON.stringify({ phone: '555-0100' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(docSend).not.toHaveBeenCalled();
  });

  describe('self-service vs admin edits (MAJ-4, F2.6)', () => {
    // Mirrors the deployed Cedar policies for a MEMBER: SelfUpdateMember is in the
    // every-role self-service policy; UpdateMember stays CHIEF/ADMIN-only.
    function memberVpClient() {
      const send = vi.fn((command: { input: { action: { actionId: string } } }) =>
        Promise.resolve({
          decision:
            command.input.action.actionId === 'SelfUpdateMember' ? Decision.ALLOW : Decision.DENY,
        }),
      );
      return { client: { send } as unknown as VerifiedPermissionsClient, send };
    }

    it('lets a MEMBER update their own profile under SelfUpdateMember', async () => {
      const { createHandler } = await import('./updateMember.js');
      const docSend = vi.fn().mockResolvedValue({});
      const vp = memberVpClient();
      const wrapped = createHandler({ client: fakeDocClient(docSend), vpClient: vp.client });

      const result = await wrapped(
        buildEvent(
          'mbr-1',
          JSON.stringify({ phone: '555-0100' }),
          { authorization: 'Bearer token' },
          SELF,
        ),
      );

      expect(result).toMatchObject({ statusCode: 200 });
      expect(vp.send.mock.calls[0]?.[0].input.action.actionId).toBe('SelfUpdateMember');
      expect(docSend).toHaveBeenCalledOnce();
    });

    it("403s a MEMBER editing another member's profile (UpdateMember) without touching DynamoDB", async () => {
      const { createHandler } = await import('./updateMember.js');
      const docSend = vi.fn();
      const vp = memberVpClient();
      const wrapped = createHandler({ client: fakeDocClient(docSend), vpClient: vp.client });

      const result = await wrapped(
        buildEvent(
          'mbr-2',
          JSON.stringify({ phone: '555-0100' }),
          { authorization: 'Bearer token' },
          SELF,
        ),
      );

      expect(result).toMatchObject({ statusCode: 403 });
      expect(vp.send.mock.calls[0]?.[0].input.action.actionId).toBe('UpdateMember');
      expect(docSend).not.toHaveBeenCalled();
    });

    it("lets an admin (UpdateMember ALLOW) edit another member's profile", async () => {
      const { createHandler } = await import('./updateMember.js');
      const docSend = vi.fn().mockResolvedValue({});
      const vp = fakeVpClient('ALLOW');
      const wrapped = createHandler({ client: fakeDocClient(docSend), vpClient: vp });

      const result = await wrapped(
        buildEvent(
          'mbr-2',
          JSON.stringify({ phone: '555-0100' }),
          { authorization: 'Bearer token' },
          { ...SELF, 'cognito:groups': 'CHIEF' },
        ),
      );

      expect(result).toMatchObject({ statusCode: 200 });
      const vpInput = (vp.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        input: { action: { actionId: string } };
      };
      expect(vpInput.input.action.actionId).toBe('UpdateMember');
    });
  });

  it('returns 503 (fail-closed) and never touches DynamoDB when Verified Permissions is unavailable', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn();
    const vpClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = createHandler({ client: fakeDocClient(docSend), vpClient });

    const result = await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: '555-0100' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    expect(result).toMatchObject({ statusCode: 503 });
    expect(docSend).not.toHaveBeenCalled();
  });

  it('returns 400 for an absent, empty, or malformed body', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn();
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    const noBody = await wrapped(
      buildEvent('mbr-1', undefined, { authorization: 'Bearer token' }, SELF),
    );
    const emptyBody = await wrapped(
      buildEvent('mbr-1', JSON.stringify({}), { authorization: 'Bearer token' }, SELF),
    );
    const wrongType = await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: 12345 }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );
    const malformed = await wrapped(
      buildEvent('mbr-1', '{not-json', { authorization: 'Bearer token' }, SELF),
    );

    expect(noBody).toMatchObject({ statusCode: 400 });
    expect(emptyBody).toMatchObject({ statusCode: 400 });
    expect(wrongType).toMatchObject({ statusCode: 400 });
    expect(malformed).toMatchObject({ statusCode: 400 });
    expect(docSend).not.toHaveBeenCalled();
  });

  it('returns 404 when the MEMBER row does not exist (transaction condition fails)', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    const result = await wrapped(
      buildEvent(
        'mbr-404',
        JSON.stringify({ phone: '555-0100' }),
        { authorization: 'Bearer token' },
        { ...SELF, sub: 'mbr-404' },
      ),
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('logs the original error and rethrows on an unexpected DynamoDB failure, emitting a failure metric', async () => {
    const { createHandler } = await import('./updateMember.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docSend = vi.fn().mockRejectedValue(new Error('table throttled'));
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    await expect(
      wrapped(
        buildEvent(
          'mbr-1',
          JSON.stringify({ phone: '555-0100' }),
          { authorization: 'Bearer token' },
          SELF,
        ),
      ),
    ).rejects.toThrow('table throttled');

    expect(errorSpy).toHaveBeenCalled();
    const loggedError = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as { message: string };
    expect(loggedError.message).toBe('table throttled');
    expect(
      logSpy.mock.calls.some((call) => (call[0] as string).includes('MemberProfileUpdateFailed')),
    ).toBe(true);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('emits a MemberProfileUpdated business metric on success', async () => {
    const { createHandler } = await import('./updateMember.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docSend = vi.fn().mockResolvedValue({});
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: '555-0100' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    expect(
      logSpy.mock.calls.some((call) => (call[0] as string).includes('MemberProfileUpdated')),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it('exercises the exported handler (entrypoint test) on a pre-AWS-call denial path', async () => {
    const { handler } = await import('./updateMember.js');
    const result = await handler(buildEvent('mbr-1', undefined, undefined, SELF));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('throws when PLATFORM_TABLE_NAME is unset (misconfigured deployment)', async () => {
    delete process.env.PLATFORM_TABLE_NAME;
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn();
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    await expect(
      wrapped(
        buildEvent(
          'mbr-1',
          JSON.stringify({ phone: '555-0100' }),
          { authorization: 'Bearer token' },
          SELF,
        ),
      ),
    ).rejects.toThrow('PLATFORM_TABLE_NAME is required and was not set');
    expect(docSend).not.toHaveBeenCalled();
  });
});
