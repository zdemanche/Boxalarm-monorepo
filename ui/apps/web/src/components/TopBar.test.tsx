import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { User, UserManager } from 'oidc-client-ts';
import { AuthProvider } from '../auth/AuthContext';
import { TopBar } from './TopBar';

afterEach(cleanup);

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'm1', 'cognito:groups': groups },
  } as unknown as User;
  return {
    getUser: vi.fn(async () => user),
    events: {
      addUserLoaded: () => undefined,
      removeUserLoaded: () => undefined,
      addUserUnloaded: () => undefined,
      removeUserUnloaded: () => undefined,
      addSilentRenewError: () => undefined,
      removeSilentRenewError: () => undefined,
    },
  } as unknown as UserManager;
}

function renderTopBar(groups: string[] = ['CHIEF']) {
  return render(
    <AuthProvider userManager={makeManager(groups)}>
      <TopBar onOpenNav={() => undefined} />
    </AuthProvider>,
  );
}

// Regression for MAJOR-2: TopBar used to render a hardcoded "Connected" string in this
// role="status" region regardless of reality — a false operational-status claim in a
// life-safety dispatch app. It's now derived from navigator.onLine and labelled for exactly
// what it measures (browser network reachability, not dispatch/API connectivity).
describe('TopBar connectivity status', () => {
  test('never renders the old fabricated "Connected" claim', async () => {
    renderTopBar();
    await screen.findByRole('status');
    expect(screen.queryByText('Connected')).toBeNull();
  });

  test('reflects navigator.onLine === true as "online"', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    renderTopBar();
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('online');
  });

  test('reflects navigator.onLine === false as "offline"', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    renderTopBar();
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('offline');
  });

  test('updates live when the browser goes offline then back online', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    renderTopBar();
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('online');

    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });
    expect(status.textContent).toContain('offline');

    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(status.textContent).toContain('online');
  });
});

// m5 (PR #321 review): with no stored palette the CSS follows prefers-color-scheme, so under a
// dark OS the cab palette is already showing and the toggle must offer "day", not "cab".
describe('TopBar palette toggle', () => {
  function mockMatchMedia(dark: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: dark && query === '(prefers-color-scheme: dark)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  test('unset palette under a dark OS offers the day palette', async () => {
    window.localStorage.clear();
    mockMatchMedia(true);
    renderTopBar();
    expect(await screen.findByRole('button', { name: 'Switch to day palette' })).toBeTruthy();
  });

  test('unset palette under a light OS offers the cab palette', async () => {
    window.localStorage.clear();
    mockMatchMedia(false);
    renderTopBar();
    expect(await screen.findByRole('button', { name: 'Switch to cab palette' })).toBeTruthy();
  });

  test('a stored choice wins over the OS scheme', async () => {
    window.localStorage.setItem('bx-palette', 'day');
    mockMatchMedia(true);
    renderTopBar();
    expect(await screen.findByRole('button', { name: 'Switch to cab palette' })).toBeTruthy();
  });
});

// m12 (PR #321 review): Cognito group order is arbitrary, so the label uses ROLE_PRIORITY.
test('labels the user with the highest-priority role, not the first group', async () => {
  renderTopBar(['MEMBER', 'TRAINING', 'CHIEF']);
  expect(await screen.findByText('Chief')).toBeTruthy();
  expect(screen.queryByText('Member')).toBeNull();
});
