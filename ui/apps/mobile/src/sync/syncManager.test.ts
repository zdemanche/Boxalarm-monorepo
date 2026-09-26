import NetInfo from '@react-native-community/netinfo';
import { ApiError, apiRequest } from '../lib/apiClient';
import * as store from './outboxStore';
import * as syncManager from './syncManager';

jest.mock('../lib/apiClient', () => ({
  ...jest.requireActual('../lib/apiClient'),
  apiRequest: jest.fn(),
}));

const mockApiRequest = apiRequest as jest.Mock;
function problem(status: number, title: string): ApiError {
  return new ApiError({ type: 'about:blank', title, status, traceId: 't' });
}

const tokens = { getAccessToken: jest.fn(), renewSilently: jest.fn() };

async function clearOutbox(): Promise<void> {
  const rows = await store.all();
  await Promise.all(rows.map((row) => store.remove(row.id)));
}

// enqueue*() only awaits the local write; the outbox drain it triggers is fire-and-forget
// (optimistic UI - the caller doesn't block on the network). Flushing a macrotask lets that
// drain's promise chain settle before a test asserts on its outcome.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  await clearOutbox();
  mockApiRequest.mockReset();
  syncManager.configure(tokens, 'https://api.example.com');
  // configure() kicks off its own drain; let it settle so it can't race the test's first drain.
  await flush();
});

test('enqueueChecklistRun POSTs to the apparatus checks path and clears the outbox on success', async () => {
  mockApiRequest.mockResolvedValueOnce({ json: async () => ({}) });

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-1', { templateId: 'CT-01' });
  await flush();

  expect(mockApiRequest).toHaveBeenCalledWith(
    'apparatus/ENGINE-2/checks',
    tokens,
    expect.objectContaining({ method: 'POST', apiBaseUrl: 'https://api.example.com' }),
  );
  await expect(store.find('check-1')).resolves.toBeUndefined();
});

test('a failed POST leaves the item queued (FAILED, not dropped) for the banner to show', async () => {
  mockApiRequest.mockRejectedValueOnce(new Error('Network request failed'));

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-2', { templateId: 'CT-01' });
  await flush();

  const row = await store.find('check-2');
  expect(row?.status).toBe('FAILED');
  expect(row?.lastError).toMatch(/network request failed/i);
});

test('a defect with a photo advances CREATE -> UPLOAD_PHOTO -> DONE and uploads to the signed uploadUrl', async () => {
  mockApiRequest.mockResolvedValueOnce({
    json: async () => ({
      uploadUrl: 'https://cdn.example.com/signed',
      photoS3Key: 'dept/defect/1/x.jpg',
    }),
  });
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      if (input === 'file:///tmp/defect.jpg') {
        return { blob: async () => new Blob(['x']) } as Response;
      }
      return { ok: true, status: 200 } as Response;
    });

  await syncManager.enqueueDefect(
    'ENGINE-2',
    'defect-1',
    { description: 'x', severity: 'MINOR', photo: { filename: 'x.jpg' } },
    'file:///tmp/defect.jpg',
  );
  await flush();

  expect(fetchSpy).toHaveBeenCalledWith(
    'https://cdn.example.com/signed',
    expect.objectContaining({ method: 'PUT' }),
  );
  await expect(store.find('defect-1')).resolves.toBeUndefined();
  fetchSpy.mockRestore();
});

test('a photo upload failure retries independently and does not re-POST the already-created defect', async () => {
  mockApiRequest.mockResolvedValueOnce({
    json: async () => ({
      uploadUrl: 'https://cdn.example.com/signed',
      photoS3Key: 'dept/defect/1/x.jpg',
    }),
  });
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      if (input === 'file:///tmp/defect.jpg') {
        return { blob: async () => new Blob(['x']) } as Response;
      }
      return { ok: false, status: 500 } as Response;
    });

  await syncManager.enqueueDefect(
    'ENGINE-2',
    'defect-2',
    { description: 'x', severity: 'MINOR', photo: { filename: 'x.jpg' } },
    'file:///tmp/defect.jpg',
  );
  await flush();

  const row = await store.find('defect-2');
  expect(row?.status).toBe('FAILED');
  expect(row?.stage).toBe('UPLOAD_PHOTO');

  mockApiRequest.mockClear();
  await syncManager.retry('defect-2');
  await flush();

  expect(mockApiRequest).not.toHaveBeenCalled();
  expect((await store.find('defect-2'))?.stage).toBe('UPLOAD_PHOTO');
  fetchSpy.mockRestore();
});

test('re-enqueueing the same idempotency key while the first is still queued is a no-op', async () => {
  let resolveRequest: (value: { json: () => Promise<Record<string, never>> }) => void;
  mockApiRequest.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRequest = resolve;
    }),
  );

  const first = syncManager.enqueueChecklistRun('ENGINE-2', 'check-dup', { templateId: 'CT-01' });
  await flush();
  // The first drain's POST is still in flight (apiRequest hasn't resolved), so the row is still
  // in the outbox - this must be a no-op, not a second queued entry.
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-dup', { templateId: 'CT-01' });

  resolveRequest!({ json: async () => ({}) });
  await first;
  await flush();

  expect(mockApiRequest).toHaveBeenCalledTimes(1);
});

test('the first drain after app start recovers a row left SYNCING by a killed process', async () => {
  await jest.isolateModulesAsync(async () => {
    // jest.requireActual/requireMock resolve through the isolated registry, so these are fresh
    // module instances (fresh fake DB, never-drained syncManager) - i.e. a new app process.
    const freshStore = jest.requireActual<typeof store>('./outboxStore');
    const freshOutbox = jest.requireActual<typeof import('./outbox')>('./outbox');
    const freshApi = jest.requireMock<{ apiRequest: jest.Mock }>('../lib/apiClient');
    freshApi.apiRequest.mockResolvedValue({ json: async () => ({}) });

    await freshOutbox.enqueue({
      id: 'orphan-1',
      kind: 'CHECKLIST_RUN',
      label: 'Truck check — ENGINE-2',
      path: 'apparatus/ENGINE-2/checks',
      body: {},
    });
    await freshOutbox.markSyncing('orphan-1');

    const freshManager = jest.requireActual<typeof syncManager>('./syncManager');
    freshManager.configure(tokens, 'https://api.example.com');
    await freshManager.drain();
    await flush();

    expect(freshApi.apiRequest).toHaveBeenCalledWith(
      'apparatus/ENGINE-2/checks',
      tokens,
      expect.anything(),
    );
    await expect(freshStore.find('orphan-1')).resolves.toBeUndefined();
  });
});

test('a 4xx validation rejection is terminal (REJECTED): kept for the user, never auto-retried', async () => {
  mockApiRequest.mockRejectedValueOnce(problem(422, 'Checklist template is retired'));

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-422', { templateId: 'CT-OLD' });
  await flush();

  const row = await store.find('check-422');
  expect(row?.status).toBe('REJECTED');
  expect(row?.lastError).toMatch(/template is retired/i);

  mockApiRequest.mockClear();
  await store.update('check-422', { nextAttemptAt: 0 });
  await syncManager.drain();
  expect(mockApiRequest).not.toHaveBeenCalled();
});

test.each([408, 429, 500, 503])('HTTP %i stays a transient FAILED with backoff', async (status) => {
  mockApiRequest.mockRejectedValueOnce(problem(status, 'try later'));

  await syncManager.enqueueChecklistRun('ENGINE-2', `check-${status}`, {});
  await flush();

  expect((await store.find(`check-${status}`))?.status).toBe('FAILED');
});

test('a REJECTED item can be manually retried or discarded', async () => {
  mockApiRequest.mockRejectedValueOnce(problem(400, 'Bad payload'));
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-400', {});
  await flush();
  expect((await store.find('check-400'))?.status).toBe('REJECTED');

  mockApiRequest.mockResolvedValueOnce({ json: async () => ({}) });
  await syncManager.retry('check-400');
  await flush();
  await expect(store.find('check-400')).resolves.toBeUndefined();

  mockApiRequest.mockRejectedValueOnce(problem(400, 'Bad payload'));
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-discard', {});
  await flush();
  await syncManager.discard('check-discard');
  await expect(store.find('check-discard')).resolves.toBeUndefined();
});

const mockAddEventListener = NetInfo.addEventListener as jest.Mock;

test('configuring tokens drains items that were queued while signed out', async () => {
  syncManager.configure(null, null);
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-signed-out', {});
  await flush();
  expect(mockApiRequest).not.toHaveBeenCalled();

  syncManager.configure(tokens, 'https://api.example.com');
  await flush();

  expect(mockApiRequest).toHaveBeenCalledTimes(1);
  await expect(store.find('check-signed-out')).resolves.toBeUndefined();
});

test('the reconnect listener is registered once while configured and removed on sign-out', async () => {
  syncManager.configure(null, null);
  mockAddEventListener.mockClear();
  const unsubscribe = jest.fn();
  mockAddEventListener.mockReturnValue(unsubscribe);

  syncManager.configure(tokens, 'https://api.example.com');
  syncManager.configure(tokens, 'https://api.example.com');
  await flush();
  expect(mockAddEventListener).toHaveBeenCalledTimes(1);

  syncManager.configure(null, null);
  expect(unsubscribe).toHaveBeenCalledTimes(1);

  syncManager.configure(tokens, 'https://api.example.com');
  await flush();
  expect(mockAddEventListener).toHaveBeenCalledTimes(2);
});

test('regaining connectivity drains the outbox', async () => {
  syncManager.configure(null, null);
  mockAddEventListener.mockClear();
  syncManager.configure(tokens, 'https://api.example.com');
  await flush();
  const onChange = mockAddEventListener.mock.calls[0][0] as (state: {
    isConnected: boolean;
  }) => void;

  mockApiRequest.mockRejectedValueOnce(new Error('Network request failed'));
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-reconnect', {});
  await flush();
  await store.update('check-reconnect', { nextAttemptAt: 0 });

  mockApiRequest.mockResolvedValueOnce({ json: async () => ({}) });
  onChange({ isConnected: true });
  await flush();

  await expect(store.find('check-reconnect')).resolves.toBeUndefined();
});

test('an item enqueued while a drain is already running is still sent by that drain cycle', async () => {
  let resolveFirst: (value: { json: () => Promise<Record<string, never>> }) => void = () => {};
  mockApiRequest
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    )
    .mockResolvedValue({ json: async () => ({}) });

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-first', {});
  await flush();
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-during', {});
  resolveFirst({ json: async () => ({}) });
  await flush();
  await flush();

  await expect(store.find('check-first')).resolves.toBeUndefined();
  await expect(store.find('check-during')).resolves.toBeUndefined();
});

async function enqueuePhotoDefect(id: string, uploadUrl: string, putStatus: number) {
  mockApiRequest.mockResolvedValueOnce({
    json: async () => ({ uploadUrl, photoS3Key: 'dept/defect/1/x.jpg' }),
  });
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      if (input === 'file:///tmp/defect.jpg') {
        return { blob: async () => new Blob(['x']) } as Response;
      }
      return { ok: putStatus < 400, status: putStatus } as Response;
    });
  await syncManager.enqueueDefect(
    'ENGINE-2',
    id,
    { description: 'x', severity: 'MINOR', photo: { filename: 'x.jpg' } },
    'file:///tmp/defect.jpg',
  );
  await flush();
  return fetchSpy;
}

test('an already-expired signed upload URL is not PUT; the item is REJECTED with a clear reason', async () => {
  const expiredUrl = 'https://cdn.example.com/signed?Expires=1700000000&Signature=s&Key-Pair-Id=k';
  const fetchSpy = await enqueuePhotoDefect('defect-expired', expiredUrl, 200);

  expect(fetchSpy).not.toHaveBeenCalledWith(expiredUrl, expect.anything());
  const row = await store.find('defect-expired');
  expect(row?.status).toBe('REJECTED');
  expect(row?.stage).toBe('UPLOAD_PHOTO');
  expect(row?.lastError).toMatch(/upload link expired/i);
  fetchSpy.mockRestore();
});

test('a 403 from the signed upload URL (expired/invalid signature) is REJECTED, not retried forever', async () => {
  const future = Math.floor(Date.now() / 1000) + 600;
  const fetchSpy = await enqueuePhotoDefect(
    'defect-403',
    `https://cdn.example.com/signed?Expires=${future}&Signature=s&Key-Pair-Id=k`,
    403,
  );

  const row = await store.find('defect-403');
  expect(row?.status).toBe('REJECTED');
  expect(row?.lastError).toMatch(/upload link expired/i);
  fetchSpy.mockRestore();
});
