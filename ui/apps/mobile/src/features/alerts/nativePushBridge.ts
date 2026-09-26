import notifee, { AuthorizationStatus } from '@notifee/react-native';
import { AppState, Platform } from 'react-native';
import Config from 'react-native-config';
import {
  getAPNSToken,
  getMessaging,
  getToken,
  onTokenRefresh,
  registerDeviceForRemoteMessages,
} from '@react-native-firebase/messaging';
import type { DeviceToken, NativePushBridge } from './pushTokens';

const messagingInstance = getMessaging();

async function readDeviceToken(): Promise<DeviceToken | null> {
  if (Platform.OS === 'ios') {
    await registerDeviceForRemoteMessages(messagingInstance);
    const token = await getAPNSToken(messagingInstance);
    return token ? { platform: 'APNS', token } : null;
  }
  const token = await getToken(messagingInstance);
  return token ? { platform: 'FCM', token } : null;
}

export const firebaseNativePushBridge: NativePushBridge = {
  async requestPermission() {
    const criticalAlertsGranted = Config.CRITICAL_ALERTS_ENTITLEMENT_GRANTED === 'true';
    const settings = await notifee.requestPermission({
      criticalAlert: criticalAlertsGranted,
    });
    return (
      settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
      settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
    );
  },

  getToken: readDeviceToken,

  onTokenRefresh(listener) {
    const forwardCurrentToken = () => {
      readDeviceToken()
        .then((device) => {
          if (device) listener(device);
        })
        .catch((error: unknown) => {
          console.warn('[push] re-reading the device push token failed', error);
        });
    };

    const unsubscribeFirebase = onTokenRefresh(messagingInstance, forwardCurrentToken);
    if (Platform.OS !== 'ios') return unsubscribeFirebase;

    // Firebase's onTokenRefresh only fires when the FCM registration token rotates, but on iOS we
    // register the raw APNs token, which rotates independently (reinstall, backup restore, OS
    // reissue) with no Firebase event. Re-read it every time the app returns to the foreground;
    // the consumer dedupes unchanged tokens, so only a real rotation triggers re-registration.
    // Cold start is covered by the consumer's initial getToken().
    const appStateSubscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') forwardCurrentToken();
    });
    return () => {
      unsubscribeFirebase();
      appStateSubscription.remove();
    };
  },
};
