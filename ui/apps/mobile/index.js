import notifee from '@notifee/react-native';
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging';
import { AppRegistry } from 'react-native';
import { App } from './src/App';
import { handleBackgroundPushMessage } from './src/features/alerts/pushNotificationDisplay';
import { name as appName } from './app.json';

// handleBackgroundPushMessage never throws: a failed display is logged and a dispatch falls back to
// a minimal critical-channel notification instead of being silently dropped.
setBackgroundMessageHandler(getMessaging(), async (remoteMessage) => {
  await handleBackgroundPushMessage(remoteMessage?.data);
});

notifee.onBackgroundEvent(async () => {});

AppRegistry.registerComponent(appName, () => App);
