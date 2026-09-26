import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthContext';
import { CompliancePage } from '../features/apparatus/CompliancePage';
import { NavListContent } from './PrimaryNav';

const server = setupServer(
  http.get('/api/v1/apparatus/compliance', () => HttpResponse.json({ report: [] })),
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
    profile: { sub: 'u1', 'cognito:groups': groups },
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

function renderAt(groups: string[], path: string, element: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('on /apparatus/compliance only "Apparatus compliance" is the current nav entry (m4)', async () => {
  renderAt(['CHIEF'], '/apparatus/compliance', <NavListContent />);

  const compliance = await screen.findByRole('link', { name: 'Apparatus compliance' });
  expect(compliance.getAttribute('aria-current')).toBe('page');
  // Testing Library string names match the full accessible name, unlike Playwright.
  expect(screen.getByRole('link', { name: 'Apparatus' }).getAttribute('aria-current')).toBeNull();
});

test('an apparatus detail page keeps "Apparatus" current (m4)', async () => {
  renderAt(['CHIEF'], '/apparatus/Engine%20301', <NavListContent />);

  const apparatus = await screen.findByRole('link', { name: 'Apparatus' });
  expect(apparatus.getAttribute('aria-current')).toBe('page');
});

test('Training events and Inventory get their own icons, not the Dashboard fallback (m4)', async () => {
  renderAt(['ADMIN'], '/settings', <NavListContent />);

  const training = await screen.findByRole('link', { name: 'Training events' });
  expect(training.querySelector('svg.lucide-graduation-cap')).not.toBeNull();
  const inventory = screen.getByRole('link', { name: 'Inventory' });
  expect(inventory.querySelector('svg.lucide-package')).not.toBeNull();
});

test('ADMIN compliance breadcrumb does not link to /apparatus, which ADMIN cannot open (m4)', async () => {
  renderAt(['ADMIN'], '/apparatus/compliance', <CompliancePage />);

  const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
  expect(within(crumbs).queryByRole('link', { name: 'Apparatus' })).toBeNull();
  expect(within(crumbs).getByText('Apparatus')).toBeTruthy();
});

test('CHIEF compliance breadcrumb links back to /apparatus (m4)', async () => {
  renderAt(['CHIEF'], '/apparatus/compliance', <CompliancePage />);

  const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
  expect(within(crumbs).getByRole('link', { name: 'Apparatus' }).getAttribute('href')).toBe(
    '/apparatus',
  );
});
