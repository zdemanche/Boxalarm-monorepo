import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import type { ChannelName } from './channelEnvelope.js';

let cachedSecretsClient: SecretsManagerClient | undefined;

export function createChannelSecretsClient(client?: SecretsManagerClient): SecretsManagerClient {
  cachedSecretsClient ??= client ?? captureAWSv3Client(new SecretsManagerClient({}));
  return cachedSecretsClient;
}

export interface ChannelProviderConfig {
  readonly endpointUrl: string;
  readonly secretId: string;
}

const ENV_PREFIX: Record<ChannelName, string> = { push: 'PUSH', sms: 'SMS', voice: 'VOICE' };

/**
 * `isTest` (self-test and canary dispatches) selects the vendor sandbox/loopback credentials
 * from `{CH}_PROVIDER_SANDBOX_SECRET_ID`, so a test never pages through a real vendor account
 * (architecture §1.3). It fails closed: a test message with no sandbox secret configured throws
 * rather than falling back to the prod credentials.
 */
export function readChannelProviderConfig(
  channel: ChannelName,
  env: NodeJS.ProcessEnv,
  options: { readonly isTest?: boolean } = {},
): ChannelProviderConfig {
  const prefix = ENV_PREFIX[channel];
  const secretKey = options.isTest
    ? `${prefix}_PROVIDER_SANDBOX_SECRET_ID`
    : `${prefix}_PROVIDER_SECRET_ID`;
  const endpointUrl = env[`${prefix}_PROVIDER_ENDPOINT_URL`];
  const secretId = env[secretKey];
  if (!endpointUrl) {
    throw new Error(`${prefix}_PROVIDER_ENDPOINT_URL is required and was not set`);
  }
  if (!secretId) {
    throw new Error(`${secretKey} is required and was not set`);
  }
  return { endpointUrl, secretId };
}

const SECRET_CACHE_TTL_MS = 15 * 60 * 1000;
const PROVIDER_REQUEST_TIMEOUT_MS = 4_000;

interface CachedSecret {
  readonly apiKey: string;
  readonly expiresAt: number;
}

const secretCache = new Map<string, CachedSecret>();

export function resetChannelSecretsCache(): void {
  secretCache.clear();
}

// Keyed by secret ID, not channel: the prod and sandbox credentials for one channel must never
// share a cache slot, or a self-test could reuse a cached prod key (or a real page a sandbox one).
async function resolveApiKey(
  secretId: string,
  secretsClient: SecretsManagerClient,
): Promise<string> {
  const cached = secretCache.get(secretId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.apiKey;
  }
  const secretOutput = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  const apiKey = secretOutput.SecretString;
  if (!apiKey) {
    throw new Error(`Secret ${secretId} has no SecretString value`);
  }
  secretCache.set(secretId, { apiKey, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return apiKey;
}

export interface SendViaHttpProviderOptions {
  /** Self-test/canary message: authenticate with the sandbox credentials. */
  readonly isTest?: boolean;
  readonly secretsClient?: SecretsManagerClient;
}

export async function sendViaHttpProvider(
  channel: ChannelName,
  target: string,
  message: string,
  env: NodeJS.ProcessEnv,
  options: SendViaHttpProviderOptions = {},
): Promise<void> {
  const config = readChannelProviderConfig(channel, env, { isTest: options.isTest === true });
  const client = createChannelSecretsClient(options.secretsClient);
  const apiKey = await resolveApiKey(config.secretId, client);
  const response = await fetch(config.endpointUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ target, message }),
    signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${channel} provider responded ${response.status}`);
  }
}
