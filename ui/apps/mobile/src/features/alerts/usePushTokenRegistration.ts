import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { getNativePushBridge, registerPushToken, type DeviceToken } from './pushTokens';

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** Backoff before the Nth consecutive retry (1-based): 5s, 10s, 20s ... capped at 5 minutes. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_MS);
}

/**
 * Requests notification permission and registers/rotates the device push token once signed in
 * (F1.-adjacent, E1-S14-UI). A device that is not registered cannot receive dispatch alerts, so
 * failures are never dropped: a failed permission/token/register step is logged with a `[push]`
 * prefix and retried in-session with exponential backoff (capped at 5 minutes, indefinitely), and
 * immediately whenever the app returns to the foreground. A denied permission is not
 * timer-retried (the OS will not re-prompt) but is re-checked on every foreground, in case the
 * member enabled notifications in Settings.
 */
export function usePushTokenRegistration(): void {
  const auth = useOptionalAuth();
  const isAuthenticated = auth?.isAuthenticated ?? false;
  const memberId = auth?.memberId ?? null;
  const apiBaseUrl = Config.API_BASE_URL;
  const authRef = useRef(auth);
  authRef.current = auth;
  const lastRegisteredRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !memberId || !apiBaseUrl) return;

    const bridge = getNativePushBridge();
    let cancelled = false;
    let inFlight = false;
    let needsRetry = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const markRegistered = () => {
      needsRetry = false;
      failures = 0;
      clearRetryTimer();
    };

    const register = async (device: DeviceToken) => {
      const key = `${device.platform}:${device.token}`;
      if (lastRegisteredRef.current === key) return;
      const tokens = authRef.current;
      if (!tokens) throw new Error('auth context unavailable');
      await registerPushToken(memberId, tokens, apiBaseUrl, device);
      if (!cancelled) lastRegisteredRef.current = key;
    };

    const onFailure = (error: unknown) => {
      if (cancelled) return;
      needsRetry = true;
      failures += 1;
      const delay = retryDelayMs(failures);
      console.warn(
        `[push] device push registration failed; retry #${failures} in ${delay}ms (device cannot receive dispatch alerts until registered)`,
        error,
      );
      clearRetryTimer();
      retryTimer = setTimeout(() => void attempt(), delay);
    };

    const attempt = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      clearRetryTimer();
      try {
        const granted = await bridge.requestPermission();
        if (cancelled) return;
        if (!granted) {
          needsRetry = true;
          console.warn(
            '[push] notification permission not granted; device is not registered for dispatch alerts',
          );
          return;
        }
        const device = await bridge.getToken();
        if (cancelled) return;
        if (!device) throw new Error('platform has not issued a device push token yet');
        await register(device);
        if (!cancelled) markRegistered();
      } catch (error) {
        onFailure(error);
      } finally {
        inFlight = false;
      }
    };

    void attempt();

    const unsubscribeRefresh = bridge.onTokenRefresh((device) => {
      register(device)
        .then(() => {
          if (!cancelled) markRegistered();
        })
        .catch(onFailure);
    });

    const appStateSubscription = AppState.addEventListener('change', (status) => {
      if (status !== 'active' || !needsRetry) return;
      failures = 0;
      void attempt();
    });

    return () => {
      cancelled = true;
      clearRetryTimer();
      unsubscribeRefresh();
      appStateSubscription.remove();
    };
  }, [isAuthenticated, memberId, apiBaseUrl]);
}
