import notifee, { AndroidImportance } from '@notifee/react-native';
import { Platform } from 'react-native';

export const CRITICAL_CHANNEL_ID = 'dispatch-critical';
export const DEFAULT_CHANNEL_ID = 'notifications-default';

export type PushCategory = 'dispatch' | 'digest';

/**
 * Deliberate fail-loud default: anything other than an explicit `'digest'` (missing, misspelled,
 * or a future category) is treated as a dispatch and routed to the critical DND-bypass channel.
 * A non-urgent notice that is too loud is recoverable; a dispatch that arrives silently is not.
 */
export function categoryFromPushData(data: { category?: unknown } | undefined): PushCategory {
  return data?.category === 'digest' ? 'digest' : 'dispatch';
}

export function channelForCategory(category: PushCategory): string {
  return category === 'dispatch' ? CRITICAL_CHANNEL_ID : DEFAULT_CHANNEL_ID;
}

export async function ensureNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await notifee.createChannel({
    id: CRITICAL_CHANNEL_ID,
    name: 'Dispatch alerts',
    importance: AndroidImportance.HIGH,
    bypassDnd: true,
    sound: 'default',
    vibration: true,
  });
  await notifee.createChannel({
    id: DEFAULT_CHANNEL_ID,
    name: 'Notifications',
    importance: AndroidImportance.DEFAULT,
    bypassDnd: false,
  });
}
