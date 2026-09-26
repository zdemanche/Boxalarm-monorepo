import NetInfo from '@react-native-community/netinfo';
import { ApiError, apiRequest, type AuthTokenSource } from '../lib/apiClient';
import type { SyncQueueStatus } from '../features/sync/types';
import * as outbox from './outbox';
import type { OutboxKind, OutboxRow } from './outbox';

type Listener = (status: SyncQueueStatus) => void;

let tokens: AuthTokenSource | null = null;
let apiBaseUrl: string | null = null;
let draining = false;
// Set when drain() is called while one is already running, so the running drain loops once more
// instead of silently skipping an entry enqueued after it listed the outbox.
let drainRequested = false;
let unsubscribeNetInfo: (() => void) | null = null;
// Set once the startup reconciliation of stranded SYNCING rows has run for this process.
let recoveredOrphans = false;
let lastSyncAt: string | null = null;
const listeners = new Set<Listener>();

// Called on every auth/config change (apiChecksRepository's effect). While signed in, a NetInfo
// listener drains on reconnect; on sign-out it is removed so repeated login/logout cycles never
// stack listeners. Entries queued while signed out are drained as soon as tokens arrive.
export function configure(nextTokens: AuthTokenSource | null, nextApiBaseUrl: string | null): void {
  tokens = nextTokens;
  apiBaseUrl = nextApiBaseUrl;
  if (tokens && apiBaseUrl) {
    unsubscribeNetInfo ??= NetInfo.addEventListener((state) => {
      if (state.isConnected === true) void drain();
    });
    void drain();
  } else if (unsubscribeNetInfo) {
    unsubscribeNetInfo();
    unsubscribeNetInfo = null;
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  void notify();
  return () => {
    listeners.delete(listener);
  };
}

async function notify(): Promise<void> {
  const status = await outbox.getStatus(lastSyncAt);
  listeners.forEach((listener) => listener(status));
}

function unitPath(unitId: string, suffix: string): string {
  return `apparatus/${encodeURIComponent(unitId)}/${suffix}`;
}

async function enqueueAndDrain(
  kind: OutboxKind,
  id: string,
  label: string,
  path: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await outbox.enqueue({ id, kind, label, path, body, photoLocalUri });
  await notify();
  void drain();
}

export async function enqueueChecklistRun(
  unitId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
): Promise<void> {
  await enqueueAndDrain(
    'CHECKLIST_RUN',
    idempotencyKey,
    `Truck check — ${unitId}`,
    unitPath(unitId, 'checks'),
    body,
  );
}

export async function enqueueDefect(
  unitId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await enqueueAndDrain(
    'DEFECT',
    idempotencyKey,
    `Defect report — ${unitId}`,
    unitPath(unitId, 'defects'),
    body,
    photoLocalUri,
  );
}

export async function retry(id: string): Promise<void> {
  await outbox.retry(id);
  await notify();
  void drain();
}

export async function discard(id: string): Promise<void> {
  await outbox.discard(id);
  await notify();
}

// The defect POST's signed photo URL is short-lived (CloudFront canned policy, ~10 min), and the
// API has no way to re-issue one: an idempotent replay of the POST returns the existing defect
// without an uploadUrl. So an expired URL can never succeed - the defect itself is already
// saved, only its photo is lost - and is surfaced to the user instead of retried forever.
class PhotoUploadUrlExpiredError extends Error {
  constructor() {
    super('Photo upload link expired - the defect was reported without its photo');
  }
}

function signedUrlExpiresAtMs(url: string): number | null {
  const match = /[?&]Expires=(\d+)/.exec(url);
  return match ? Number(match[1]) * 1000 : null;
}

// A 4xx means the server refused this request as sent, so an identical retry cannot succeed -
// except 408 (timeout) and 429 (throttled), which are transient. 401 never reaches here as
// permanent in practice: apiRequest already renewed the token once, and a still-expired session
// is recoverable by signing in again, so it is treated as transient too.
function isPermanentRejection(error: unknown): boolean {
  if (error instanceof PhotoUploadUrlExpiredError) return true;
  if (!(error instanceof ApiError)) return false;
  const { status } = error.problem;
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return error instanceof Error ? error.message : String(error);
}

function guessPhotoContentType(uri: string): string {
  const extension = uri.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

async function uploadPhoto(row: OutboxRow): Promise<void> {
  if (!row.photoLocalUri || !row.photoUploadUrl) return;
  const expiresAtMs = signedUrlExpiresAtMs(row.photoUploadUrl);
  if (expiresAtMs !== null && Date.now() >= expiresAtMs) throw new PhotoUploadUrlExpiredError();
  const fileResponse = await fetch(row.photoLocalUri);
  const blob = await fileResponse.blob();
  const uploadResponse = await fetch(row.photoUploadUrl, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': guessPhotoContentType(row.photoLocalUri) },
  });
  // CloudFront answers an expired or otherwise invalid signature with 403.
  if (uploadResponse.status === 403) throw new PhotoUploadUrlExpiredError();
  if (!uploadResponse.ok) {
    throw new Error(`Photo upload failed with status ${uploadResponse.status}`);
  }
}

async function processEntry(id: string): Promise<void> {
  if (!tokens || !apiBaseUrl) throw new Error('Sync is not configured yet');
  let row = await outbox.find(id);
  if (!row) return;

  if (row.stage === 'CREATE') {
    const response = await apiRequest(row.path, tokens, {
      apiBaseUrl,
      method: row.method,
      headers: { 'Content-Type': 'application/json' },
      body: row.body,
    });
    const parsed = (await response.json().catch(() => ({}))) as {
      uploadUrl?: string;
      photoS3Key?: string;
    };
    const nextStage = parsed.uploadUrl && row.photoLocalUri ? 'UPLOAD_PHOTO' : 'DONE';
    await outbox.advanceStage(row.id, {
      stage: nextStage,
      photoUploadUrl: parsed.uploadUrl ?? null,
      photoS3Key: parsed.photoS3Key ?? null,
    });
    row = await outbox.find(row.id);
    if (!row) return;
  }

  if (row.stage === 'UPLOAD_PHOTO') {
    await uploadPhoto(row);
    await outbox.advanceStage(row.id, { stage: 'DONE' });
  }
}

export async function drain(): Promise<void> {
  if (!tokens || !apiBaseUrl) return;
  if (draining) {
    drainRequested = true;
    return;
  }
  draining = true;
  drainRequested = false;
  try {
    // Runs inside the draining lock so no row of this process can be genuinely mid-sync.
    if (!recoveredOrphans) {
      await outbox.recoverOrphanedSyncing();
      recoveredOrphans = true;
    }
    const netState = await NetInfo.fetch();
    if (netState.isConnected !== true) return;

    const pending = await outbox.listDrainable(Date.now());
    for (const row of pending) {
      await outbox.markSyncing(row.id);
      await notify();
      try {
        await processEntry(row.id);
        await outbox.markSynced(row.id);
        lastSyncAt = new Date().toISOString();
      } catch (error) {
        if (isPermanentRejection(error)) {
          await outbox.markRejected(row.id, describeError(error));
        } else {
          await outbox.markFailed(row.id, describeError(error));
        }
      }
      await notify();
    }
  } finally {
    draining = false;
  }
  if (drainRequested) void drain();
}
