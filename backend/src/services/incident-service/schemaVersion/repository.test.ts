import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DuplicateSchemaVersionError, createSchemaVersionRepository } from './repository.js';
import { createConfigCache } from '../../platform-service/config/cache.js';

const TABLE_NAME = 'boxalarm-dev-incident';

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('createSchemaVersionRepository', () => {
  it('publishes a new SCHEMA_VERSION as ACTIVE and points ACTIVE_POINTER at it (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createSchemaVersionRepository(
      fakeClient(send),
      TABLE_NAME,
      createConfigCache({ ttlMs: 1000 }),
    );

    const result = await repository.publishSchemaVersion({
      version: '2026.2',
      coreSchemaS3Key: 'neris-schema/2026.2/core.json',
      secondarySchemaS3Key: 'neris-schema/2026.2/secondary.json',
      publishedAt: 1_798_000_000,
    });

    expect(result).toMatchObject({ version: '2026.2', status: 'ACTIVE' });
    const [command] = send.mock.calls[0] as [
      { input: { TransactItems: { Put: { Item: Record<string, unknown> } }[] } },
    ];
    expect(command.input.TransactItems[0]?.Put.Item).toMatchObject({
      pk: 'SCHEMA_VERSION',
      sk: 'NERIS#2026.2',
      status: 'ACTIVE',
    });
    expect(command.input.TransactItems[1]?.Put.Item).toMatchObject({
      pk: 'SCHEMA_VERSION',
      sk: 'ACTIVE_POINTER',
      activeVersion: '2026.2',
    });
  });

  it('rejects republishing an existing version as DuplicateSchemaVersionError', async () => {
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    const repository = createSchemaVersionRepository(
      fakeClient(send),
      TABLE_NAME,
      createConfigCache({ ttlMs: 1000 }),
    );

    await expect(
      repository.publishSchemaVersion({
        version: '2026.2',
        coreSchemaS3Key: 'k1',
        secondarySchemaS3Key: 'k2',
        publishedAt: 1,
      }),
    ).rejects.toThrow(DuplicateSchemaVersionError);
  });

  it('resolves the active version by reading ACTIVE_POINTER then the version item (AC3)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { activeVersion: '2026.2' } })
      .mockResolvedValueOnce({
        Item: {
          version: '2026.2',
          status: 'ACTIVE',
          coreSchemaS3Key: 'k1',
          secondarySchemaS3Key: 'k2',
          publishedAt: 1,
        },
      });
    const repository = createSchemaVersionRepository(
      fakeClient(send),
      TABLE_NAME,
      createConfigCache({ ttlMs: 1000 }),
    );

    const active = await repository.getActiveSchemaVersion();

    expect(active).toMatchObject({ version: '2026.2' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('resolves the active schema version when the method is destructured off the repository', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { activeVersion: '2026.2' } })
      .mockResolvedValueOnce({
        Item: {
          version: '2026.2',
          status: 'ACTIVE',
          coreSchemaS3Key: 'k1',
          secondarySchemaS3Key: 'k2',
          publishedAt: 1,
        },
      });
    const { getActiveSchemaVersion } = createSchemaVersionRepository(
      fakeClient(send),
      TABLE_NAME,
      createConfigCache({ ttlMs: 1000 }),
    );

    await expect(getActiveSchemaVersion()).resolves.toMatchObject({ version: '2026.2' });
  });

  it('caches the active pointer lookup within the TTL (AC3 no stale-beyond-TTL, positive side)', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { activeVersion: '2026.2' } });
    const repository = createSchemaVersionRepository(
      fakeClient(send),
      TABLE_NAME,
      createConfigCache({ ttlMs: 60_000 }),
    );

    await repository.getActiveVersionNumber();
    await repository.getActiveVersionNumber();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('shares the default pointer cache across repositories, since handlers build one per request', async () => {
    vi.resetModules();
    const { createSchemaVersionRepository: freshFactory } = await import('./repository.js');
    const send = vi.fn().mockResolvedValue({ Item: { activeVersion: '2026.2' } });

    await freshFactory(fakeClient(send), TABLE_NAME).getActiveVersionNumber();
    await freshFactory(fakeClient(send), TABLE_NAME).getActiveVersionNumber();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when an incident-validated version (N-1) is looked up after N is published (AC2)', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Item: {
        version: '2026.1',
        status: 'SUPERSEDED',
        coreSchemaS3Key: 'k1',
        secondarySchemaS3Key: 'k2',
        publishedAt: 1,
      },
    });
    const repository = createSchemaVersionRepository(
      fakeClient(send),
      TABLE_NAME,
      createConfigCache({ ttlMs: 1000 }),
    );

    const superseded = await repository.getSchemaVersion('2026.1');

    expect(superseded).toMatchObject({ version: '2026.1' });
  });
});
