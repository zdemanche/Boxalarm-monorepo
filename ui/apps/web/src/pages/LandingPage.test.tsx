import { typography } from '@boxalarm/design-tokens';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { User, UserManager } from 'oidc-client-ts';
import { AuthProvider } from '../auth/AuthContext';
import { LandingPage } from './LandingPage';

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

function makeManager(profile: Record<string, unknown>): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile,
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

function renderLanding(profile: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(profile)}>
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('renders the highest-priority role dashboard when CHIEF is present', async () => {
  renderLanding({ sub: 'm1', 'cognito:groups': ['MEMBER', 'CHIEF'] });
  await screen.findByRole('heading', { name: 'Chief dashboard' });
});

test('falls back to member home when no groups are present', async () => {
  renderLanding({ sub: 'm1' });
  await screen.findByRole('heading', { name: 'Member home' });
});

test('the heading uses the design-token type scale, matching the sign-in page', async () => {
  renderLanding({ sub: 'm1' });
  const heading = await screen.findByRole('heading', { name: 'Member home' });
  expect(heading.style.fontSize).toBe(`${typography.size.xl}px`);
});

// Regression for MAJOR-2: the dashboard used to hardcode "No active call." as fact in a
// role="status" live region regardless of whether a call was actually active. There is no
// incidents/dispatch feature in this app yet, so the honest state is an explicit
// "not wired" placeholder, not a fabricated claim.
test('CHIEF dashboard never claims "No active call" — shows an honest not-wired placeholder instead', async () => {
  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  await screen.findByRole('heading', { name: 'Chief dashboard' });
  expect(screen.queryByText(/no active call/i)).toBeNull();
  expect(screen.getByText(/active-call status isn.t wired to this dashboard yet/i)).toBeTruthy();
});

// Regression for MAJOR-3: routeTable.ts grants /apparatus to APPARATUS|CHIEF only, but OFFICER
// is a DASHBOARD_ROLES member and this dashboard used to fetch apparatus for every dashboard
// role regardless — an OFFICER's dashboard triggered a request Cedar denies with 403 on every
// visit, and the failure rendered as a clean "0 / 0 apparatus in service" tile.
test('OFFICER dashboard never requests apparatus (routeTable denies it) and shows no apparatus tiles', async () => {
  let apparatusRequested = false;
  server.use(
    http.get('/api/v1/apparatus', () => {
      apparatusRequested = true;
      return HttpResponse.json({ apparatus: [] });
    }),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['OFFICER'] });
  await screen.findByRole('heading', { name: 'Officer dashboard' });
  // Members is granted to OFFICER, so that tile should still render.
  await screen.findByText('Active members');

  expect(apparatusRequested).toBe(false);
  expect(screen.queryByText('Apparatus in service')).toBeNull();
  expect(screen.queryByText('Out of service')).toBeNull();
});

// Regression for MAJOR-3: a failed query (offline, 500, or a 403 that slips through role gating)
// used to fall through `data ?? []`, so the tile silently read "0 / 0" — a failure rendered as a
// healthy zero, and the project's ApiError/ApiForbiddenGate convention was never invoked.
test('a failed apparatus query renders the generic ApiErrorState, never a "0 / 0" tile', async () => {
  server.use(
    http.get('/api/v1/apparatus', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          traceId: 'trace-1',
        },
        { status: 500 },
      ),
    ),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  await screen.findByRole('heading', { name: 'Something went wrong loading this page' });
  expect(screen.queryByText(/0 \/ 0/)).toBeNull();
});

test('CHIEF dashboard reads the real { apparatus } list payload into the tiles (m9)', async () => {
  server.use(
    http.get('/api/v1/apparatus', () =>
      HttpResponse.json({
        apparatus: [
          { apparatusId: 'a1', unitId: 'E1', type: 'Engine', status: 'IN_SERVICE' },
          { apparatusId: 'a2', unitId: 'T1', type: 'Ladder', status: 'OUT_OF_SERVICE' },
        ],
      }),
    ),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  await screen.findByRole('heading', { name: 'Chief dashboard' });
  expect(await screen.findByText('1 / 2')).toBeTruthy();
  expect(screen.queryByText('Something went wrong loading this page')).toBeNull();
});
