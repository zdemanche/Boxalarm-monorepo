import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  SCHEMA_DOCUMENT_CACHE_TTL_MS,
  clearSchemaDocumentCache,
  getCoreSchemaDocument,
  getSecondarySchemaDocument,
} from './s3Schema.js';

const BUCKET = 'neris-schema-bucket';
const CORE_KEY = 'neris-schema/2026.2/core.json';
const SECONDARY_KEY = 'neris-schema/2026.2/secondary.json';

function s3Returning(documentFor: (key: string) => unknown): {
  client: S3Client;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockImplementation((command: { input: { Key: string } }) =>
    Promise.resolve({
      Body: {
        transformToString: () => Promise.resolve(JSON.stringify(documentFor(command.input.Key))),
      },
    }),
  );
  return { client: { send } as unknown as S3Client, send };
}

beforeEach(() => {
  clearSchemaDocumentCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('schema document cache', () => {
  it('fetches a document from S3 once and serves repeat reads from cache', async () => {
    const { client, send } = s3Returning(() => ({ version: '2026.2', fields: {} }));

    const first = await getCoreSchemaDocument(client, BUCKET, CORE_KEY);
    const second = await getCoreSchemaDocument(client, BUCKET, CORE_KEY);

    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('coalesces concurrent reads of the same key onto one GetObject', async () => {
    const { client, send } = s3Returning(() => ({ version: '2026.2' }));

    await Promise.all([
      getCoreSchemaDocument(client, BUCKET, CORE_KEY),
      getCoreSchemaDocument(client, BUCKET, CORE_KEY),
      getCoreSchemaDocument(client, BUCKET, CORE_KEY),
    ]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by object key so core and secondary documents never collide', async () => {
    const { client, send } = s3Returning((key) => ({ key }));

    const core = await getCoreSchemaDocument(client, BUCKET, CORE_KEY);
    const secondary = await getSecondarySchemaDocument(client, BUCKET, SECONDARY_KEY);

    expect(send).toHaveBeenCalledTimes(2);
    expect(core).toEqual({ key: CORE_KEY });
    expect(secondary).toEqual({ key: SECONDARY_KEY });
  });

  it('refetches after the TTL expires', async () => {
    vi.useFakeTimers();
    const { client, send } = s3Returning(() => ({ version: '2026.2' }));

    await getCoreSchemaDocument(client, BUCKET, CORE_KEY);
    vi.advanceTimersByTime(SCHEMA_DOCUMENT_CACHE_TTL_MS + 1);
    await getCoreSchemaDocument(client, BUCKET, CORE_KEY);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed fetch, so the next call retries', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('S3 unavailable'))
      .mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify({ version: '2026.2' })) },
      });
    const client = { send } as unknown as S3Client;

    await expect(getCoreSchemaDocument(client, BUCKET, CORE_KEY)).rejects.toThrow('S3 unavailable');
    await expect(getCoreSchemaDocument(client, BUCKET, CORE_KEY)).resolves.toEqual({
      version: '2026.2',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
