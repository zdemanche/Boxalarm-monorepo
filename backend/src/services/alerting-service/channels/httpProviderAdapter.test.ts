import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function fakeSecretsClient(secretString: string | undefined): {
  client: SecretsManagerClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  return { client: { send } as unknown as SecretsManagerClient, send };
}

beforeEach(() => {
  vi.resetModules();
  process.env.PUSH_PROVIDER_ENDPOINT_URL = 'https://push.example';
  process.env.PUSH_PROVIDER_SECRET_ID = 'push-secret';
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

describe('readChannelProviderConfig', () => {
  it.each([['PUSH_PROVIDER_ENDPOINT_URL'], ['PUSH_PROVIDER_SECRET_ID']])(
    'throws when %s is not set (fail closed, no network call)',
    async (missingKey) => {
      const { readChannelProviderConfig } = await import('./httpProviderAdapter.js');
      const env: NodeJS.ProcessEnv = {
        PUSH_PROVIDER_ENDPOINT_URL: 'https://push.example',
        PUSH_PROVIDER_SECRET_ID: 'push-secret',
        [missingKey]: undefined,
      };
      expect(() => readChannelProviderConfig('push', env)).toThrow(
        `${missingKey} is required and was not set`,
      );
    },
  );
});

describe('sendViaHttpProvider', () => {
  it('resolves the api key from Secrets Manager and posts target+message with bearer auth', async () => {
    const { client, send } = fakeSecretsClient('api-key-1');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    globalThis.fetch = fetchMock;
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await sendViaHttpProvider('push', 'push-token-1', 'structure-fire — 12 Main St', process.env, {
      secretsClient: client,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://push.example');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer api-key-1' });
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ target: 'push-token-1', message: 'structure-fire — 12 Main St' }),
    );
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects when the provider connection accepts but never responds (bounded by the abort signal)', async () => {
    const { client } = fakeSecretsClient('api-key-1');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () =>
            reject(new Error('TimeoutError')),
          );
        }),
    );
    globalThis.fetch = fetchMock;
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    const pending = sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, {
      secretsClient: client,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
    signal?.dispatchEvent(new Event('abort'));

    await expect(pending).rejects.toThrow('TimeoutError');
  });

  it('throws when the provider responds with a non-ok status', async () => {
    const { client } = fakeSecretsClient('api-key-1');
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 503 } as Response);
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await expect(
      sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, { secretsClient: client }),
    ).rejects.toThrow('push provider responded 503');
  });

  it('throws when the secret has no SecretString value, never falling back to an env literal', async () => {
    const { client } = fakeSecretsClient(undefined);
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await expect(
      sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, { secretsClient: client }),
    ).rejects.toThrow('has no SecretString value');
  });

  it('caches the resolved secret across sends on the hot delivery path (one GetSecretValueCommand for two sends)', async () => {
    const { client, send } = fakeSecretsClient('api-key-1');
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, {
      secretsClient: client,
    });
    await sendViaHttpProvider('push', 'push-token-2', 'msg', process.env, {
      secretsClient: client,
    });

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('sendViaHttpProvider — isTest selects the sandbox credentials (architecture §1.3)', () => {
  function secretsClientBySecretId(): {
    client: SecretsManagerClient;
    send: ReturnType<typeof vi.fn>;
  } {
    const send = vi.fn((command: { input: { SecretId: string } }) =>
      Promise.resolve({ SecretString: `key-for-${command.input.SecretId}` }),
    );
    return { client: { send } as unknown as SecretsManagerClient, send };
  }

  function okFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    globalThis.fetch = fetchMock;
    return fetchMock;
  }

  function authHeader(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, call: number): unknown {
    return ((fetchMock.mock.calls[call]?.[1] as RequestInit).headers as Record<string, string>)
      .authorization;
  }

  it('authenticates an isTest send with the sandbox secret, never the prod one', async () => {
    process.env.PUSH_PROVIDER_SANDBOX_SECRET_ID = 'push-sandbox-secret';
    const { client, send } = secretsClientBySecretId();
    const fetchMock = okFetch();
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, {
      isTest: true,
      secretsClient: client,
    });

    const secretIds = send.mock.calls.map(
      (call) => (call[0] as { input: { SecretId: string } }).input.SecretId,
    );
    expect(secretIds).toEqual(['push-sandbox-secret']);
    expect(authHeader(fetchMock, 0)).toBe('Bearer key-for-push-sandbox-secret');
  });

  it('fails closed when an isTest send has no sandbox secret configured (no prod fallback, no network call)', async () => {
    delete process.env.PUSH_PROVIDER_SANDBOX_SECRET_ID;
    const { client, send } = secretsClientBySecretId();
    const fetchMock = okFetch();
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await expect(
      sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, {
        isTest: true,
        secretsClient: client,
      }),
    ).rejects.toThrow('PUSH_PROVIDER_SANDBOX_SECRET_ID is required and was not set');
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps prod and sandbox keys in separate cache slots (a test never reuses the prod key or vice versa)', async () => {
    process.env.PUSH_PROVIDER_SANDBOX_SECRET_ID = 'push-sandbox-secret';
    const { client } = secretsClientBySecretId();
    const fetchMock = okFetch();
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await sendViaHttpProvider('push', 't', 'msg', process.env, { secretsClient: client });
    await sendViaHttpProvider('push', 't', 'msg', process.env, {
      isTest: true,
      secretsClient: client,
    });
    await sendViaHttpProvider('push', 't', 'msg', process.env, { secretsClient: client });

    expect(authHeader(fetchMock, 0)).toBe('Bearer key-for-push-secret');
    expect(authHeader(fetchMock, 1)).toBe('Bearer key-for-push-sandbox-secret');
    expect(authHeader(fetchMock, 2)).toBe('Bearer key-for-push-secret');
  });
});
