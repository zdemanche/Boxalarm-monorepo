import { Platform } from 'react-native';
import notifee from '@notifee/react-native';
import { CRITICAL_CHANNEL_ID, DEFAULT_CHANNEL_ID } from './pushChannel';
import { displayPushNotification, handleBackgroundPushMessage } from './pushNotificationDisplay';

const displayNotification = notifee.displayNotification as jest.Mock;
const createChannel = notifee.createChannel as jest.Mock;
let consoleError: jest.SpyInstance;

beforeEach(() => {
  displayNotification.mockReset().mockResolvedValue(undefined);
  createChannel.mockClear();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

test('a dispatch push displays on the critical channel with a full-screen action', async () => {
  Platform.OS = 'android';

  await displayPushNotification({ dispatchId: 'DISP-1', title: 'Structure fire' });

  const call = displayNotification.mock.calls[0][0];
  expect(call.android.channelId).toBe(CRITICAL_CHANNEL_ID);
  expect(call.android.fullScreenAction).toBeDefined();
  expect(call.data).toEqual({ dispatchId: 'DISP-1', category: 'dispatch' });
});

test('a digest push displays on the default channel without a full-screen action', async () => {
  Platform.OS = 'android';

  await displayPushNotification({ category: 'digest', title: 'Cert expiring' });

  const call = displayNotification.mock.calls[0][0];
  expect(call.android.channelId).toBe(DEFAULT_CHANNEL_ID);
  expect(call.android.fullScreenAction).toBeUndefined();
});

test('does nothing on iOS, where the OS displays the push natively', async () => {
  Platform.OS = 'ios';

  await displayPushNotification({ dispatchId: 'DISP-1' });

  expect(displayNotification).not.toHaveBeenCalled();
});

test('background handler displays the push normally when display succeeds', async () => {
  Platform.OS = 'android';

  await handleBackgroundPushMessage({ dispatchId: 'DISP-1', title: 'Structure fire' });

  expect(displayNotification).toHaveBeenCalledTimes(1);
  expect(consoleError).not.toHaveBeenCalled();
});

test('background handler logs a failed dispatch display and posts a minimal critical-channel fallback', async () => {
  Platform.OS = 'android';
  displayNotification.mockRejectedValueOnce(new Error('full-screen intent not permitted'));

  await expect(
    handleBackgroundPushMessage({ dispatchId: 'DISP-1', title: 'Structure fire' }),
  ).resolves.toBeUndefined();

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[push]'), expect.any(Error));
  // The channel may never have been created if the app has not been foregrounded since install.
  expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: CRITICAL_CHANNEL_ID }));
  expect(displayNotification).toHaveBeenCalledTimes(2);
  const fallback = displayNotification.mock.calls[1][0];
  expect(fallback.android.channelId).toBe(CRITICAL_CHANNEL_ID);
  expect(fallback.android.fullScreenAction).toBeUndefined();
  expect(fallback.title).toBe('Dispatch alert');
  expect(fallback.data).toEqual({ dispatchId: 'DISP-1', category: 'dispatch' });
});

test('background handler does not post a critical fallback for a failed digest push', async () => {
  Platform.OS = 'android';
  displayNotification.mockRejectedValueOnce(new Error('boom'));

  await handleBackgroundPushMessage({ category: 'digest', title: 'Cert expiring' });

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[push]'), expect.any(Error));
  expect(displayNotification).toHaveBeenCalledTimes(1);
});

test('background handler never throws, even when the fallback also fails', async () => {
  Platform.OS = 'android';
  displayNotification.mockRejectedValue(new Error('notifee unavailable'));

  await expect(handleBackgroundPushMessage({ dispatchId: 'DISP-1' })).resolves.toBeUndefined();

  expect(displayNotification).toHaveBeenCalledTimes(2);
  expect(consoleError).toHaveBeenCalledTimes(2);
});
