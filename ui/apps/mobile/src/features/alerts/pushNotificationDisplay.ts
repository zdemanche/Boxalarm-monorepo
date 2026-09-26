import notifee, { AndroidImportance } from '@notifee/react-native';
import { Platform } from 'react-native';
import {
  categoryFromPushData,
  channelForCategory,
  CRITICAL_CHANNEL_ID,
  ensureNotificationChannels,
} from './pushChannel';

export interface PushMessageData {
  category?: string;
  dispatchId?: string;
  title?: string;
  body?: string;
}

export async function displayPushNotification(data: PushMessageData | undefined): Promise<void> {
  if (Platform.OS !== 'android') return;

  const category = categoryFromPushData(data);
  const isCritical = category === 'dispatch';
  const channelId = channelForCategory(category);

  await notifee.displayNotification({
    title: data?.title ?? (isCritical ? 'Dispatch alert' : 'Notification'),
    body: data?.body,
    data: { dispatchId: data?.dispatchId ?? '', category },
    android: {
      channelId,
      importance: isCritical ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
      pressAction: { id: 'default' },
      ...(isCritical ? { fullScreenAction: { id: 'default' } } : {}),
    },
  });
}

/**
 * Background-isolate entry for data pushes (wired in index.js). A throw here would silently drop
 * the local display of a dispatch alert with no diagnostic, so it never throws: a failed display is
 * logged and, for a dispatch, retried as a minimal critical-channel notification - no full-screen
 * action (a missing USE_FULL_SCREEN_INTENT grant is a plausible cause of the first failure) and a
 * fresh ensureNotificationChannels() (the channel may not exist yet if the app has not been
 * foregrounded since install).
 */
export async function handleBackgroundPushMessage(
  data: PushMessageData | undefined,
): Promise<void> {
  try {
    await displayPushNotification(data);
    return;
  } catch (error) {
    console.error('[push] displaying a background push failed', error);
  }

  if (categoryFromPushData(data) !== 'dispatch') return;

  try {
    await ensureNotificationChannels();
    await notifee.displayNotification({
      title: 'Dispatch alert',
      body: 'Open Boxalarm for details.',
      data: {
        dispatchId: typeof data?.dispatchId === 'string' ? data.dispatchId : '',
        category: 'dispatch',
      },
      android: {
        channelId: CRITICAL_CHANNEL_ID,
        importance: AndroidImportance.HIGH,
        pressAction: { id: 'default' },
      },
    });
  } catch (error) {
    console.error('[push] fallback dispatch notification also failed; alert not displayed', error);
  }
}
