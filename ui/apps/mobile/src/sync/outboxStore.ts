import { getDb } from './db';

export type OutboxKind = 'CHECKLIST_RUN' | 'DEFECT';
export type OutboxStage = 'CREATE' | 'UPLOAD_PHOTO' | 'DONE';
// FAILED is transient (retried with backoff); REJECTED is terminal (the server refused the
// request itself, e.g. a 4xx validation error) and waits for the user to retry or discard it.
export type OutboxRowStatus = 'QUEUED' | 'SYNCING' | 'FAILED' | 'REJECTED';

export interface OutboxRow {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly label: string;
  readonly method: 'POST';
  readonly path: string;
  readonly body: string;
  readonly stage: OutboxStage;
  readonly photoLocalUri: string | null;
  readonly photoS3Key: string | null;
  readonly photoUploadUrl: string | null;
  readonly status: OutboxRowStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly queuedAt: string;
  readonly nextAttemptAt: number;
  readonly syncedAt: string | null;
}

function toRow(record: Record<string, unknown>): OutboxRow {
  return {
    id: String(record.id),
    kind: record.kind as OutboxKind,
    label: String(record.label),
    method: 'POST',
    path: String(record.path),
    body: String(record.body),
    stage: record.stage as OutboxStage,
    photoLocalUri: (record.photoLocalUri as string | null) ?? null,
    photoS3Key: (record.photoS3Key as string | null) ?? null,
    photoUploadUrl: (record.photoUploadUrl as string | null) ?? null,
    status: record.status as OutboxRowStatus,
    attempts: Number(record.attempts),
    lastError: (record.lastError as string | null) ?? null,
    queuedAt: String(record.queuedAt),
    nextAttemptAt: Number(record.nextAttemptAt),
    syncedAt: (record.syncedAt as string | null) ?? null,
  };
}

export async function insert(row: OutboxRow): Promise<void> {
  await getDb().execute(
    `INSERT INTO outbox
      (id, kind, label, method, path, body, stage, photoLocalUri, photoS3Key, photoUploadUrl,
       status, attempts, lastError, queuedAt, nextAttemptAt, syncedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.kind,
      row.label,
      row.method,
      row.path,
      row.body,
      row.stage,
      row.photoLocalUri,
      row.photoS3Key,
      row.photoUploadUrl,
      row.status,
      row.attempts,
      row.lastError,
      row.queuedAt,
      row.nextAttemptAt,
      row.syncedAt,
    ],
  );
}

export async function all(): Promise<OutboxRow[]> {
  const result = await getDb().execute('SELECT * FROM outbox ORDER BY queuedAt ASC');
  return result.rows.map(toRow);
}

export async function find(id: string): Promise<OutboxRow | undefined> {
  const result = await getDb().execute('SELECT * FROM outbox WHERE id = ?', [id]);
  const record = result.rows[0];
  return record ? toRow(record) : undefined;
}

export async function update(id: string, patch: Partial<OutboxRow>): Promise<void> {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value ?? null);
  await getDb().execute(`UPDATE outbox SET ${assignments} WHERE id = ?`, [...values, id]);
}

export async function remove(id: string): Promise<void> {
  await getDb().execute('DELETE FROM outbox WHERE id = ?', [id]);
}
