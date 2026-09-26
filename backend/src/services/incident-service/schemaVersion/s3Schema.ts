import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { NerisSchemaDocument, NerisSecondarySchemaDocument } from './entity.js';

async function readBody(body: unknown): Promise<string> {
  const stream = body as { transformToString?: () => Promise<string> } | undefined;
  if (!stream?.transformToString) {
    throw new Error('S3 object body does not support transformToString');
  }
  return stream.transformToString();
}

export async function putSchemaDocument(
  s3: S3Client,
  bucket: string,
  key: string,
  document: NerisSchemaDocument | NerisSecondarySchemaDocument,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(document),
      ContentType: 'application/json',
    }),
  );
}

/**
 * Schema documents live at version-scoped keys (`neris-schema/{version}/…`) that the
 * refresh job writes once per published version, so a fetched document is safe to
 * reuse for the life of a warm container. The TTL (same as SCHEMA_VERSION's) only
 * bounds how long a re-uploaded object for an existing key could be served stale.
 * The in-flight promise is cached so concurrent callers coalesce onto one GetObject;
 * a failed fetch is evicted so the next call retries instead of caching the error.
 */
export const SCHEMA_DOCUMENT_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedDocument {
  readonly promise: Promise<unknown>;
  readonly expiresAt: number;
}

const documentCache = new Map<string, CachedDocument>();

/** Test hook: drop every cached schema document. */
export function clearSchemaDocumentCache(): void {
  documentCache.clear();
}

async function fetchDocument(s3: S3Client, bucket: string, key: string): Promise<unknown> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await readBody(result.Body)) as unknown;
}

function getCachedDocument<T>(
  s3: S3Client,
  bucket: string,
  key: string,
  now: number = Date.now(),
): Promise<T> {
  const cacheKey = `${bucket}/${key}`;
  const hit = documentCache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return hit.promise as Promise<T>;
  }
  const promise = fetchDocument(s3, bucket, key).catch((error: unknown) => {
    if (documentCache.get(cacheKey)?.promise === promise) {
      documentCache.delete(cacheKey);
    }
    throw error;
  });
  documentCache.set(cacheKey, { promise, expiresAt: now + SCHEMA_DOCUMENT_CACHE_TTL_MS });
  return promise as Promise<T>;
}

export function getCoreSchemaDocument(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<NerisSchemaDocument> {
  return getCachedDocument<NerisSchemaDocument>(s3, bucket, key);
}

export function getSecondarySchemaDocument(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<NerisSecondarySchemaDocument> {
  return getCachedDocument<NerisSecondarySchemaDocument>(s3, bucket, key);
}
