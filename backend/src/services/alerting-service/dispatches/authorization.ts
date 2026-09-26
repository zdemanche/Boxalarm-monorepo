import {
  IsAuthorizedWithTokenCommand,
  VerifiedPermissionsClient,
} from '@aws-sdk/client-verifiedpermissions';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { logError } from './logger.js';

export interface AuthorizationConfig {
  readonly policyStoreId: string;
}

export function readAuthorizationConfig(env: NodeJS.ProcessEnv): AuthorizationConfig {
  const policyStoreId = env.VERIFIED_PERMISSIONS_POLICY_STORE_ID;
  if (!policyStoreId) {
    throw new Error('VERIFIED_PERMISSIONS_POLICY_STORE_ID is required and was not set');
  }
  return { policyStoreId };
}

let cachedClient: VerifiedPermissionsClient | undefined;

function createVerifiedPermissionsClient(): VerifiedPermissionsClient {
  return captureAWSv3Client(new VerifiedPermissionsClient({}));
}

export function getVerifiedPermissionsClient(): VerifiedPermissionsClient {
  cachedClient ??= createVerifiedPermissionsClient();
  return cachedClient;
}

export type AuthorizationOutcome = 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';

export interface AuthorizationRequestContext {
  readonly traceId: string;
  readonly deptId: VerifiedDeptId;
}

export async function authorizeManualDispatchSubmission(
  client: VerifiedPermissionsClient,
  config: AuthorizationConfig,
  accessToken: string,
  context: AuthorizationRequestContext,
): Promise<AuthorizationOutcome> {
  try {
    const result = await client.send(
      // Declared in infrastructure/components/authz/cedar-policies.ts (alerting officer tier).
      new IsAuthorizedWithTokenCommand({
        policyStoreId: config.policyStoreId,
        accessToken,
        action: { actionType: 'Boxalarm::Action', actionId: 'SubmitManualDispatch' },
        resource: { entityType: 'Boxalarm::Department', entityId: context.deptId },
      }),
    );
    return result.decision === 'ALLOW' ? 'ALLOWED' : 'DENIED';
  } catch (error) {
    logError('dispatches.authorization.unavailable', error, {
      traceId: context.traceId,
      deptId: context.deptId,
    });
    return 'UNAVAILABLE';
  }
}
