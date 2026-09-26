import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { getNativePushBridge, registerPushToken, type DeviceToken } from './pushTokens';
import { retryDelayMs, usePushTokenRegistration } from './usePushTokenRegistration';

jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('./pushTokens', () => ({ getNativePushBridge: jest.fn(), registerPushToken: jest.fn() }));
// jest.setup.js pins API_BASE_URL to '' globally, which short-circuits the hook.
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.test' },
}));

const mockUseOptionalAuth = useOptionalAuth as jest.Mock;
const mockGetNativePushBridge = getNativePushBridge as jest.Mock;
const mockRegisterPushToken = registerPushToken as jest.Mock;

const DEVICE: DeviceToken = { platform: 'APNS', token: 'apns-token' };

let refreshListener: ((device: DeviceToken) => void) | undefined;
let fireAppState: (status: AppStateStatus) => void;
let removeAppStateListener: jest.Mock;
let warn: jest.SpyInstance;
const bridge = {
  requestPermission: jest.fn(),
  getToken: jest.fn(),
  onTokenRefresh: jest.fn(),
};

// The hook awaits permission -> token -> register in sequence; drain enough microtask turns for
// the whole chain to settle without advancing fake time.
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockUseOptionalAuth.mockReturnValue({
    isAuthenticated: true,
    memberId: 'MBR-1',
    getAccessToken: jest.fn(),
    renewSilently: jest.fn(),
  });
  bridge.requestPermission.mockReset().mockResolvedValue(true);
  bridge.getToken.mockReset().mockResolvedValue(DEVICE);
  bridge.onTokenRefresh.mockReset().mockImplementation((listener) => {
    refreshListener = listener;
    return () => {};
  });
  mockGetNativePushBridge.mockReturnValue(bridge);
  mockRegisterPushToken.mockReset().mockResolvedValue(undefined);

  let appStateHandler: ((status: AppStateStatus) => void) | undefined;
  removeAppStateListener = jest.fn();
  const addEventListener = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    listener: (status: AppStateStatus) => void,
  ) => {
    appStateHandler = listener;
    return { remove: removeAppStateListener };
  }) as unknown as typeof AppState.addEventListener);
  addEventListener.mockClear();
  fireAppState = (status) => appStateHandler?.(status);

  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('registers the device token once permission is granted', async () => {
  await renderHook(() => usePushTokenRegistration());
  await flush();

  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);
  expect(mockRegisterPushToken).toHaveBeenCalledWith(
    'MBR-1',
    expect.anything(),
    'https://api.example.test',
    DEVICE,
  );
});

test('retryDelayMs backs off exponentially and caps at five minutes', () => {
  expect(retryDelayMs(1)).toBe(5_000);
  expect(retryDelayMs(2)).toBe(10_000);
  expect(retryDelayMs(3)).toBe(20_000);
  expect(retryDelayMs(50)).toBe(300_000);
});

test('a failed register call is logged and retried in-session with backoff', async () => {
  mockRegisterPushToken
    .mockRejectedValueOnce(new Error('network down'))
    .mockRejectedValueOnce(new Error('network down'))
    .mockResolvedValue(undefined);

  await renderHook(() => usePushTokenRegistration());
  await flush();
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[push]'), expect.any(Error));

  await advance(4_999);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(2);

  await advance(9_999);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(3);

  // Registered now - no further timed attempts.
  await advance(600_000);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(3);
});

test('a platform that has not issued a token yet is retried instead of silently giving up', async () => {
  bridge.getToken.mockResolvedValueOnce(null).mockResolvedValue(DEVICE);

  await renderHook(() => usePushTokenRegistration());
  await flush();
  expect(mockRegisterPushToken).not.toHaveBeenCalled();

  await advance(5_000);
  expect(mockRegisterPushToken).toHaveBeenCalledWith(
    'MBR-1',
    expect.anything(),
    'https://api.example.test',
    DEVICE,
  );
});

test('a thrown native bridge error is caught and retried', async () => {
  bridge.getToken
    .mockRejectedValueOnce(new Error('native module missing'))
    .mockResolvedValue(DEVICE);

  await renderHook(() => usePushTokenRegistration());
  await flush();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[push]'), expect.any(Error));

  await advance(5_000);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);
});

test('returning to the foreground retries immediately while unregistered', async () => {
  mockRegisterPushToken.mockRejectedValueOnce(new Error('network down'));

  await renderHook(() => usePushTokenRegistration());
  await flush();
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);

  fireAppState('active');
  await flush();
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(2);

  // The pending backoff timer was superseded by the successful foreground retry.
  await advance(600_000);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(2);
});

test('returning to the foreground does nothing extra once registered', async () => {
  await renderHook(() => usePushTokenRegistration());
  await flush();

  fireAppState('active');
  await flush();

  expect(bridge.getToken).toHaveBeenCalledTimes(1);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);
});

test('denied permission is logged, not timer-retried, and re-checked on foreground', async () => {
  bridge.requestPermission.mockResolvedValueOnce(false).mockResolvedValue(true);

  await renderHook(() => usePushTokenRegistration());
  await flush();
  expect(mockRegisterPushToken).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[push]'));

  await advance(600_000);
  expect(bridge.requestPermission).toHaveBeenCalledTimes(1);

  fireAppState('active');
  await flush();
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);
});

test('a rotated token from the bridge is registered, and a failure there is retried', async () => {
  await renderHook(() => usePushTokenRegistration());
  await flush();
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);

  const rotated: DeviceToken = { platform: 'APNS', token: 'rotated' };
  bridge.getToken.mockResolvedValue(rotated);
  mockRegisterPushToken.mockRejectedValueOnce(new Error('network down'));
  refreshListener?.(rotated);
  await flush();
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(2);

  await advance(5_000);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(3);
  expect(mockRegisterPushToken).toHaveBeenLastCalledWith(
    'MBR-1',
    expect.anything(),
    'https://api.example.test',
    rotated,
  );
});

test('an unchanged token from the bridge is not re-registered', async () => {
  await renderHook(() => usePushTokenRegistration());
  await flush();

  refreshListener?.(DEVICE);
  await flush();

  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);
});

test('unmounting cancels pending retries and removes the foreground listener', async () => {
  mockRegisterPushToken.mockRejectedValue(new Error('network down'));

  const { unmount } = await renderHook(() => usePushTokenRegistration());
  await flush();
  await unmount();

  await advance(600_000);
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);
  expect(removeAppStateListener).toHaveBeenCalled();
});
