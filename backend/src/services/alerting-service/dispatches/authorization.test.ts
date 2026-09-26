import { describe, expect, it, vi } from 'vitest';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { authorizeManualDispatchSubmission, readAuthorizationConfig } from './authorization.js';

function fakeClient(send: (command: unknown) => Promise<unknown>): VerifiedPermissionsClient {
  return { send } as unknown as VerifiedPermissionsClient;
}

const config = { policyStoreId: 'store-1' };
const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const context = { traceId: 'trace-1', deptId };

describe('readAuthorizationConfig', () => {
  it('reads the policy store id from VERIFIED_PERMISSIONS_POLICY_STORE_ID', () => {
    expect(readAuthorizationConfig({ VERIFIED_PERMISSIONS_POLICY_STORE_ID: 'store-1' })).toEqual({
      policyStoreId: 'store-1',
    });
  });

  it('fails fast when VERIFIED_PERMISSIONS_POLICY_STORE_ID is not set', () => {
    expect(() => readAuthorizationConfig({})).toThrow('VERIFIED_PERMISSIONS_POLICY_STORE_ID');
  });
});

describe('authorizeManualDispatchSubmission (AC3)', () => {
  it('returns ALLOWED when Verified Permissions decides ALLOW', async () => {
    const client = fakeClient(() => Promise.resolve({ decision: 'ALLOW' }));
    const outcome = await authorizeManualDispatchSubmission(client, config, 'token-1', context);
    expect(outcome).toBe('ALLOWED');
  });

  it('returns DENIED (maps to 403) when Verified Permissions decides DENY for a non-admin, non-officer member', async () => {
    const client = fakeClient(() => Promise.resolve({ decision: 'DENY' }));
    const outcome = await authorizeManualDispatchSubmission(client, config, 'token-1', context);
    expect(outcome).toBe('DENIED');
  });

  it('fails secure — returns UNAVAILABLE (maps to 503), never a defaulted ALLOW, on a Verified Permissions outage', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeClient(() => Promise.reject(new Error('service unavailable')));
    const outcome = await authorizeManualDispatchSubmission(client, config, 'token-1', context);
    expect(outcome).toBe('UNAVAILABLE');
    expect(outcome).not.toBe('ALLOWED');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('service unavailable'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('trace-1'));
  });

  it('sends the department-scoped IsAuthorizedWithToken command shape (policyStoreId, action, resource, deptId)', async () => {
    let sentInput: unknown;
    const client = fakeClient((command) => {
      sentInput = (command as { input: unknown }).input;
      return Promise.resolve({ decision: 'ALLOW' });
    });
    await authorizeManualDispatchSubmission(client, config, 'token-1', context);
    expect(sentInput).toMatchObject({
      policyStoreId: 'store-1',
      accessToken: 'token-1',
      action: { actionType: 'Boxalarm::Action', actionId: 'SubmitManualDispatch' },
      resource: { entityType: 'Boxalarm::Department', entityId: deptId },
    });
  });
});
