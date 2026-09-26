import * as store from './outboxStore';
import type { OutboxKind, OutboxRow } from './outboxStore';
import type { SyncItem, SyncQueueStatus } from '../features/sync/types';

export type { OutboxRow, OutboxKind } from './outboxStore';

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface EnqueueInput {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly label: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly photoLocalUri?: string;
}

// Create-only by design: the id is the client idempotency key, so re-enqueueing an id already in
// the outbox is a no-op that keeps the ORIGINAL payload (any changed fields are dropped). There is
// no edit/merge or cross-device conflict handling - if an update (PUT/PATCH) path is ever queued
// here, it needs update-in-place and a conflict strategy rather than this dedup.
export async function enqueue(input: EnqueueInput): Promise<OutboxRow> {
  const existing = await store.find(input.id);
  if (existing) return existing;
  const row: OutboxRow = {
    id: input.id,
    kind: input.kind,
    label: input.label,
    method: 'POST',
    path: input.path,
    body: JSON.stringify(input.body),
    stage: 'CREATE',
    photoLocalUri: input.photoLocalUri ?? null,
    photoS3Key: null,
    photoUploadUrl: null,
    status: 'QUEUED',
    attempts: 0,
    lastError: null,
    queuedAt: new Date().toISOString(),
    nextAttemptAt: Date.now(),
    syncedAt: null,
  };
  await store.insert(row);
  return row;
}

export async function find(id: string): Promise<OutboxRow | undefined> {
  return store.find(id);
}

export async function listDrainable(now: number): Promise<OutboxRow[]> {
  const rows = await store.all();
  return rows.filter(
    (row) => row.status !== 'SYNCING' && row.status !== 'REJECTED' && row.nextAttemptAt <= now,
  );
}

export async function markSyncing(id: string): Promise<void> {
  await store.update(id, { status: 'SYNCING' });
}

// A row is only SYNCING while this process's drain() is working on it, so any SYNCING row found
// before the first drain of a process was stranded by a kill/crash mid-sync. Without this reset
// listDrainable would exclude it forever. Safe to re-POST: the row id is the idempotency key.
export async function recoverOrphanedSyncing(): Promise<void> {
  const rows = await store.all();
  const orphaned = rows.filter((row) => row.status === 'SYNCING');
  await Promise.all(
    orphaned.map((row) => store.update(row.id, { status: 'QUEUED', nextAttemptAt: Date.now() })),
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  const row = await store.find(id);
  const attempts = (row?.attempts ?? 0) + 1;
  const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
  await store.update(id, {
    status: 'FAILED',
    attempts,
    lastError: error,
    nextAttemptAt: Date.now() + backoffMs,
  });
}

export async function markRejected(id: string, error: string): Promise<void> {
  const row = await store.find(id);
  await store.update(id, {
    status: 'REJECTED',
    attempts: (row?.attempts ?? 0) + 1,
    lastError: error,
  });
}

export async function markSynced(id: string): Promise<void> {
  await store.remove(id);
}

export async function retry(id: string): Promise<void> {
  await store.update(id, { status: 'QUEUED', nextAttemptAt: Date.now() });
}

export async function discard(id: string): Promise<void> {
  await store.remove(id);
}

export async function advanceStage(
  id: string,
  patch: {
    readonly stage: 'UPLOAD_PHOTO' | 'DONE';
    readonly photoUploadUrl?: string | null;
    readonly photoS3Key?: string | null;
  },
): Promise<void> {
  await store.update(id, patch);
}

export async function getStatus(lastSyncAt: string | null): Promise<SyncQueueStatus> {
  const rows = await store.all();
  const items: SyncItem[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    status: row.status,
    queuedAt: row.queuedAt,
    lastError: row.lastError,
  }));
  return { items, lastSyncAt };
}
