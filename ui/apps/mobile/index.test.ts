import { setBackgroundMessageHandler } from '@react-native-firebase/messaging';
import { AppRegistry } from 'react-native';
import { App } from './src/App';
import { handleBackgroundPushMessage } from './src/features/alerts/pushNotificationDisplay';

jest.mock('react-native', () => ({ AppRegistry: { registerComponent: jest.fn() } }));
jest.mock('./src/App', () => ({
  App: function MockApp() {
    return null;
  },
}));
jest.mock('./src/features/alerts/pushNotificationDisplay', () => ({
  handleBackgroundPushMessage: jest.fn(async () => undefined),
}));

import './index';

test('registers the root App component under the app.json display name', () => {
  const registerComponent = AppRegistry.registerComponent as jest.Mock;
  expect(registerComponent).toHaveBeenCalledTimes(1);

  const [name, factory] = registerComponent.mock.calls[0] as [string, () => unknown];
  expect(name).toBe('Boxalarm');
  expect(factory()).toBe(App);
});

test('routes background FCM messages through the fail-safe background handler', async () => {
  const setHandler = setBackgroundMessageHandler as jest.Mock;
  expect(setHandler).toHaveBeenCalledTimes(1);

  const handler = setHandler.mock.calls[0][1] as (message: unknown) => Promise<void>;
  await handler({ data: { dispatchId: 'DISP-1' } });

  expect(handleBackgroundPushMessage).toHaveBeenCalledWith({ dispatchId: 'DISP-1' });
});
