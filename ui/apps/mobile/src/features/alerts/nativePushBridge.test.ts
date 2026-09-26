import { AppState, Platform, type AppStateStatus } from 'react-native';
import notifee from '@notifee/react-native';
import * as messaging from '@react-native-firebase/messaging';
import { firebaseNativePushBridge } from './nativePushBridge';

jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { CRITICAL_ALERTS_ENTITLEMENT_GRANTED: 'false' },
}));

const requestPermission = notifee.requestPermission as jest.Mock;
const getToken = messaging.getToken as jest.Mock;
const getAPNSToken = messaging.getAPNSToken as jest.Mock;
const registerDeviceForRemoteMessages = messaging.registerDeviceForRemoteMessages as jest.Mock;
const onTokenRefresh = messaging.onTokenRefresh as jest.Mock;

function captureAppStateHandler(): {
  fire: (status: AppStateStatus) => void;
  remove: jest.Mock;
  addEventListener: jest.SpyInstance;
} {
  let handler: ((status: AppStateStatus) => void) | undefined;
  const remove = jest.fn();
  const addEventListener = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    listener: (status: AppStateStatus) => void,
  ) => {
    handler = listener;
    return { remove };
  }) as unknown as typeof AppState.addEventListener);
  // The RN jest preset already makes addEventListener a jest.fn, so spyOn reuses it and
  // restoreAllMocks does not reset its call history between tests.
  addEventListener.mockClear();
  return { fire: (status) => handler?.(status), remove, addEventListener };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  requestPermission.mockClear();
  getToken.mockClear();
  getAPNSToken.mockClear();
  registerDeviceForRemoteMessages.mockClear();
});

test('requestPermission asks for the iOS critical-alert option only when the entitlement is granted', async () => {
  requestPermission.mockResolvedValueOnce({ authorizationStatus: 1 });

  const granted = await firebaseNativePushBridge.requestPermission();

  expect(granted).toBe(true);
  expect(requestPermission).toHaveBeenCalledWith({ criticalAlert: false });
});

test('requestPermission treats provisional authorization as granted', async () => {
  requestPermission.mockResolvedValueOnce({ authorizationStatus: 2 });
  await expect(firebaseNativePushBridge.requestPermission()).resolves.toBe(true);
});

test('requestPermission treats denial as not granted', async () => {
  requestPermission.mockResolvedValueOnce({ authorizationStatus: 0 });
  await expect(firebaseNativePushBridge.requestPermission()).resolves.toBe(false);
});

test('getToken reads the FCM token on Android', async () => {
  Platform.OS = 'android';
  getToken.mockResolvedValueOnce('fcm-token');

  await expect(firebaseNativePushBridge.getToken()).resolves.toEqual({
    platform: 'FCM',
    token: 'fcm-token',
  });
});

test('getToken registers for remote messages then reads the raw APNs token on iOS', async () => {
  Platform.OS = 'ios';
  getAPNSToken.mockResolvedValueOnce('apns-token');

  await expect(firebaseNativePushBridge.getToken()).resolves.toEqual({
    platform: 'APNS',
    token: 'apns-token',
  });
  expect(registerDeviceForRemoteMessages).toHaveBeenCalled();
});

test('getToken returns null when the platform has not issued a token yet', async () => {
  Platform.OS = 'android';
  getToken.mockResolvedValueOnce(null);
  await expect(firebaseNativePushBridge.getToken()).resolves.toBeNull();
});

test('onTokenRefresh re-reads the platform token and forwards it to the listener', async () => {
  Platform.OS = 'android';
  getToken.mockResolvedValue('rotated-token');
  let refreshCallback: (() => void) | undefined;
  onTokenRefresh.mockImplementationOnce((_instance: unknown, cb: () => void) => {
    refreshCallback = cb;
    return () => {};
  });

  const listener = jest.fn();
  firebaseNativePushBridge.onTokenRefresh(listener);
  refreshCallback?.();
  await Promise.resolve();
  await Promise.resolve();

  expect(listener).toHaveBeenCalledWith({ platform: 'FCM', token: 'rotated-token' });
});

test('on iOS, returning to the foreground re-reads the APNs token so a silent APNs rotation is re-registered', async () => {
  // Firebase's onTokenRefresh only fires on FCM-token rotation; iOS registers the raw APNs token,
  // which rotates on its own schedule (reinstall, restore, OS reissue) with no Firebase event.
  Platform.OS = 'ios';
  const appState = captureAppStateHandler();
  getAPNSToken.mockResolvedValue('rotated-apns-token');

  const listener = jest.fn();
  firebaseNativePushBridge.onTokenRefresh(listener);
  appState.fire('background');
  await flushPromises();
  expect(listener).not.toHaveBeenCalled();

  appState.fire('active');
  await flushPromises();

  expect(listener).toHaveBeenCalledWith({ platform: 'APNS', token: 'rotated-apns-token' });
});

test('on iOS, unsubscribing removes both the Firebase and the foreground listeners', () => {
  Platform.OS = 'ios';
  const appState = captureAppStateHandler();
  const firebaseUnsubscribe = jest.fn();
  onTokenRefresh.mockImplementationOnce(() => firebaseUnsubscribe);

  const unsubscribe = firebaseNativePushBridge.onTokenRefresh(jest.fn());
  unsubscribe();

  expect(firebaseUnsubscribe).toHaveBeenCalled();
  expect(appState.remove).toHaveBeenCalled();
});

test('on Android, no foreground listener is added - FCM onTokenRefresh covers rotation', () => {
  Platform.OS = 'android';
  const appState = captureAppStateHandler();

  firebaseNativePushBridge.onTokenRefresh(jest.fn());

  expect(appState.addEventListener).not.toHaveBeenCalled();
});

test('a failing token re-read is caught and logged instead of becoming an unhandled rejection', async () => {
  Platform.OS = 'ios';
  const appState = captureAppStateHandler();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  getAPNSToken.mockRejectedValueOnce(new Error('apns unavailable'));

  const listener = jest.fn();
  firebaseNativePushBridge.onTokenRefresh(listener);
  appState.fire('active');
  await flushPromises();

  expect(listener).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[push]'), expect.any(Error));
});
