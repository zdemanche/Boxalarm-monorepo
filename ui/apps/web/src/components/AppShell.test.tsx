import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthContext';
import { AppShell } from '../components/AppShell';
import { LandingPage } from '../pages/LandingPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { RequireAuth } from '../routing/RequireAuth';
import { RequireRole } from '../routing/RequireRole';

const server = setupServer(
  http.get('/api/v1/apparatus', () => HttpResponse.json({ apparatus: [] })),
  http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
);
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'm1', 'cognito:groups': groups },
  } as unknown as User;
  return {
    getUser: vi.fn(async () => user),
    signoutRedirect: vi.fn(async () => undefined),
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

function renderShell(groups: string[], initialPath: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route
              path="/"
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<LandingPage />} />
              <Route
                path="alerts/diagnostics"
                element={
                  <RequireRole>
                    <PlaceholderPage title="Alert diagnostics" />
                  </RequireRole>
                }
              />
              <Route
                path="settings"
                element={
                  <RequireRole>
                    <PlaceholderPage title="Settings" />
                  </RequireRole>
                }
              />
              <Route
                path="audit-log"
                element={
                  <RequireRole>
                    <PlaceholderPage title="Audit log" />
                  </RequireRole>
                }
              />
              <Route
                path="personnel"
                element={
                  <RequireRole>
                    <PlaceholderPage title="Personnel" />
                  </RequireRole>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('CHIEF PrimaryNav shows dashboard and audit-log, not settings', async () => {
  renderShell(['CHIEF'], '/');
  await screen.findByRole('heading', { name: 'Chief dashboard' });
  const nav = screen.getByRole('navigation', { name: 'Primary' });
  expect(nav.textContent).toContain('Dashboard');
  expect(nav.textContent).toContain('Audit log');
  expect(nav.textContent).not.toContain('Settings');
});

test('ADMIN visiting /settings sees the page; CHIEF visiting /settings sees Forbidden', async () => {
  renderShell(['ADMIN'], '/settings');
  await screen.findByRole('heading', { name: 'Settings' });

  cleanup();
  renderShell(['CHIEF'], '/settings');
  await screen.findByRole('heading', { name: 'Forbidden' });
  // The 403 body is a fixed generic message now — the server's raw detail/traceId (which can
  // leak internal Cedar policy/action names) is intentionally kept out of the rendered DOM.
  expect(screen.getByText('You do not have access to this page.')).toBeTruthy();
  expect(screen.queryByText(/Reference:/i)).toBeNull();
});

test('ADMIN landing on / redirects to first granted route', async () => {
  renderShell(['ADMIN'], '/');
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Alert diagnostics' })).toBeTruthy();
  });
});

// Regression for MAJOR-1: below 768px (and at 200% zoom), PrimaryNav's static sidebar is
// display:none with no replacement, so the web app had no route navigation and no Sign out at
// all. NavDrawer, opened from TopBar's hamburger button, is that replacement.
test('NavDrawer: the hamburger button opens a dialog containing the granted nav links and Sign out', async () => {
  const user = userEvent.setup();
  renderShell(['CHIEF'], '/');
  await screen.findByRole('heading', { name: 'Chief dashboard' });

  // The dialog isn't in the DOM until opened.
  expect(screen.queryByRole('dialog')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Open navigation' }));

  const dialog = await screen.findByRole('dialog');
  const withinDialog = within(dialog);
  expect(withinDialog.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  expect(withinDialog.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
  expect(withinDialog.getByRole('link', { name: 'Audit log' })).toBeTruthy();
  expect(withinDialog.getByRole('button', { name: 'Sign out' })).toBeTruthy();
});

test('NavDrawer: choosing a nav link inside the drawer navigates and closes the drawer', async () => {
  const user = userEvent.setup();
  renderShell(['CHIEF'], '/');
  await screen.findByRole('heading', { name: 'Chief dashboard' });

  await user.click(screen.getByRole('button', { name: 'Open navigation' }));
  const dialog = await screen.findByRole('dialog');

  await user.click(within(dialog).getByRole('link', { name: 'Audit log' }));

  await screen.findByRole('heading', { name: 'Audit log' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('NavDrawer: Escape closes the drawer (Radix Dialog focus trap)', async () => {
  const user = userEvent.setup();
  renderShell(['CHIEF'], '/');
  await screen.findByRole('heading', { name: 'Chief dashboard' });

  await user.click(screen.getByRole('button', { name: 'Open navigation' }));
  await screen.findByRole('dialog');

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
