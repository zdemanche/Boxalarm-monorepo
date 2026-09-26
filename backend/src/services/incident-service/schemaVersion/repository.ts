import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { createConfigCache, type ConfigCache } from '../../platform-service/config/cache.js';
import type { SchemaVersion, SchemaVersionStatus } from './entity.js';

const PK = 'SCHEMA_VERSION';
const ACTIVE_POINTER_SK = 'ACTIVE_POINTER';

/** Architecture-described Valkey TTL for SCHEMA_VERSION reference data. */
export const SCHEMA_VERSION_CACHE_TTL_MS = 5 * 60 * 1000;

export class DuplicateSchemaVersionError extends Error {
  constructor(version: string) {
    super(`schema version "${version}" has already been published`);
    this.name = 'DuplicateSchemaVersionError';
  }
}

function toSchemaVersion(item: Record<string, unknown>): SchemaVersion {
  return {
    version: item.version as string,
    status: item.status as SchemaVersionStatus,
    coreSchemaS3Key: item.coreSchemaS3Key as string,
    secondarySchemaS3Key: item.secondarySchemaS3Key as string,
    publishedAt: item.publishedAt as number,
  };
}

export interface PublishSchemaVersionInput {
  readonly version: string;
  readonly coreSchemaS3Key: string;
  readonly secondarySchemaS3Key: string;
  readonly publishedAt: number;
}

// Function-typed properties (not methods): the implementation never uses `this`, so
// callers and test mocks may safely destructure them.
export interface SchemaVersionRepository {
  readonly publishSchemaVersion: (input: PublishSchemaVersionInput) => Promise<SchemaVersion>;
  readonly getSchemaVersion: (version: string) => Promise<SchemaVersion | undefined>;
  readonly getActiveVersionNumber: () => Promise<string | undefined>;
  readonly getActiveSchemaVersion: () => Promise<SchemaVersion | undefined>;
}

// Module scope, not per call: handlers build a repository per request, so a default
// cache created inside the factory never survived past one invocation and the
// ACTIVE_POINTER lookup was never actually cached across requests.
const sharedActivePointerCache = createConfigCache({ ttlMs: SCHEMA_VERSION_CACHE_TTL_MS });

export function createSchemaVersionRepository(
  client: DynamoDBDocumentClient,
  tableName: string,
  cache: ConfigCache = sharedActivePointerCache,
): SchemaVersionRepository {
  // Methods reference `repository`, never `this`, so they still work when destructured.
  const repository: SchemaVersionRepository = {
    async publishSchemaVersion(input) {
      const item = {
        pk: 'SCHEMA_VERSION',
        sk: `NERIS#${input.version}`,
        entityType: 'SCHEMA_VERSION',
        version: input.version,
        status: 'ACTIVE',
        coreSchemaS3Key: input.coreSchemaS3Key,
        secondarySchemaS3Key: input.secondarySchemaS3Key,
        publishedAt: input.publishedAt,
      };
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: item,
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    pk: 'SCHEMA_VERSION',
                    sk: ACTIVE_POINTER_SK,
                    entityType: 'SCHEMA_VERSION_ACTIVE_POINTER',
                    activeVersion: input.version,
                  },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (
          error instanceof TransactionCanceledException &&
          error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
        ) {
          throw new DuplicateSchemaVersionError(input.version);
        }
        throw error;
      }
      cache.invalidate(PK, ACTIVE_POINTER_SK);
      return toSchemaVersion(item);
    },

    async getSchemaVersion(version) {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: 'SCHEMA_VERSION', sk: `NERIS#${version}` },
        }),
      );
      return result.Item ? toSchemaVersion(result.Item as Record<string, unknown>) : undefined;
    },

    async getActiveVersionNumber() {
      return cache.getOrLoad<string | undefined>(PK, ACTIVE_POINTER_SK, async () => {
        const result = await client.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: 'SCHEMA_VERSION', sk: ACTIVE_POINTER_SK },
          }),
        );
        const activeVersion = (result.Item as { activeVersion?: unknown } | undefined)
          ?.activeVersion;
        return typeof activeVersion === 'string' ? activeVersion : undefined;
      });
    },

    async getActiveSchemaVersion() {
      const version = await repository.getActiveVersionNumber();
      if (!version) {
        return undefined;
      }
      return repository.getSchemaVersion(version);
    },
  };
  return repository;
}

let cachedRepository: SchemaVersionRepository | undefined;

export function getSchemaVersionRepository(
  client: DynamoDBDocumentClient,
  tableName: string,
): SchemaVersionRepository {
  cachedRepository ??= createSchemaVersionRepository(client, tableName);
  return cachedRepository;
}
