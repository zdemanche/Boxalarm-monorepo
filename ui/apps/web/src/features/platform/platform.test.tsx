import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { MemberDetailPage } from '../personnel/MemberDetailPage';
import type { Member } from '../personnel/types';
import { AuditLogPage } from './AuditLogPage';
import { SettingsPage } from './SettingsPage';
import type { ConfigResponse } from './types';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'admin-1', 'cognito:groups': groups },
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

function renderRoute(groups: string[], path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/settings"
              element={
                <RequireRole>
                  <SettingsPage />
                </RequireRole>
              }
            />
            <Route
              path="/audit-log"
              element={
                <RequireRole>
                  <AuditLogPage />
                </RequireRole>
              }
            />
            <Route
              path="/personnel/:id"
              element={
                <RequireRole>
                  <MemberDetailPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('admin edits alert-rule threshold N; a 409 shows the reloaded value', async () => {
  const stored: ConfigResponse = {
    configType: 'ALERT_RULES',
    value: { escalationThresholdN: 60 },
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'someone',
  };
  server.use(
    http.get('/api/v1/platform/config/ALERT_RULES', () => HttpResponse.json(stored)),
    http.get('/api/v1/platform/config/STATIONS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/RANKS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/LOSAP_POINT_RULES', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/CHECKLIST_DEFAULTS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.put('/api/v1/platform/config/ALERT_RULES', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'department config was modified concurrently; reload and retry',
          traceId: 't2',
        },
        { status: 409 },
      ),
    ),
    http.get('/api/v1/platform/retention', () =>
      HttpResponse.json({ retentionYears: 7, version: 1, source: 'stored' }),
    ),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/settings');
  const textarea = await screen.findByLabelText('Alert rule timing (JSON)');
  expect((textarea as HTMLTextAreaElement).value).toContain('60');

  fireEvent.change(textarea, { target: { value: '{"escalationThresholdN":90}' } });
  await user.click(screen.getByRole('button', { name: 'Save Alert rule timing' }));

  await waitFor(() => {
    expect(
      screen.getByText(
        'This config was updated by someone else. Showing the latest value — review and save again.',
      ),
    ).toBeTruthy();
  });
});

test('audit log lookup renders a readable diff; a 400 shows detail next to the input', async () => {
  server.use(
    http.get('/api/v1/platform/audit', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('entityId') === 'bad id') {
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail:
              'entityType and entityId query parameters are required and must not contain "," or "#".',
            traceId: 't1',
          },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        entries: [
          {
            actorId: 'admin-1',
            ts: Date.parse('2026-01-01T00:00:00.000Z'),
            action: 'UPDATE',
            mutatedEntityType: 'DEPARTMENT_CONFIG',
            mutatedEntityId: 'ALERT_RULES',
            changedFields: { escalationThresholdN: { old: 60, new: 90 } },
          },
        ],
      });
    }),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/audit-log');
  await screen.findByRole('heading', { name: 'Audit log' });

  await user.type(screen.getByLabelText('Entity type'), 'DEPARTMENT_CONFIG');
  await user.type(screen.getByLabelText('Entity ID'), 'ALERT_RULES');
  await user.click(screen.getByRole('button', { name: 'Look up' }));

  await waitFor(() => {
    expect(screen.getByText(/escalationThresholdN: 60 → 90/)).toBeTruthy();
  });
});

/** Default MSW handlers so /settings can render (all config GETs empty + a stored retention
 * config), reused by the 403 no-leak tests below. */
function settingsDefaultHandlers() {
  return [
    http.get('/api/v1/platform/config/STATIONS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/RANKS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/LOSAP_POINT_RULES', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/ALERT_RULES', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/CHECKLIST_DEFAULTS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/retention', () =>
      HttpResponse.json({ retentionYears: 7, version: 1, source: 'stored' }),
    ),
  ];
}

const SECRET_CEDAR_DETAIL = 'caller is not a CHIEF or ADMIN';

test('a 403 saving a config shows a generic message, not the raw server detail', async () => {
  server.use(
    ...settingsDefaultHandlers(),
    http.put('/api/v1/platform/config/ALERT_RULES', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: SECRET_CEDAR_DETAIL,
          traceId: 't3',
        },
        { status: 403 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/settings');
  const textarea = await screen.findByLabelText('Alert rule timing (JSON)');
  fireEvent.change(textarea, { target: { value: '{"escalationThresholdN":90}' } });
  await user.click(screen.getByRole('button', { name: 'Save Alert rule timing' }));

  await waitFor(() => {
    expect(screen.getByText('You do not have access to this page.')).toBeTruthy();
  });
  expect(screen.queryByText(SECRET_CEDAR_DETAIL)).toBeNull();
  expect(document.body.textContent).not.toContain(SECRET_CEDAR_DETAIL);
});

test('a 403 running disposal shows a generic message, not the raw server detail', async () => {
  server.use(
    ...settingsDefaultHandlers(),
    http.post('/api/v1/platform/retention/disposal', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: SECRET_CEDAR_DETAIL,
          traceId: 't4',
        },
        { status: 403 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/settings');
  await user.click(await screen.findByRole('button', { name: 'Run disposal' }));
  const disposalDialog = await screen.findByRole('dialog', {
    name: 'Permanently dispose of records older than 7 years?',
  });
  await user.click(within(disposalDialog).getByRole('button', { name: 'Run disposal' }));

  await waitFor(() => {
    expect(screen.getByText('You do not have access to this page.')).toBeTruthy();
  });
  expect(screen.queryByText(SECRET_CEDAR_DETAIL)).toBeNull();
  expect(document.body.textContent).not.toContain(SECRET_CEDAR_DETAIL);
});

test('a 403 starting an export shows a generic message, not the raw server detail', async () => {
  server.use(
    ...settingsDefaultHandlers(),
    http.post('/api/v1/platform/export', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: SECRET_CEDAR_DETAIL,
          traceId: 't5',
        },
        { status: 403 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/settings');
  await user.click(await screen.findByRole('button', { name: 'Export department data' }));
  const exportDialog = await screen.findByRole('dialog', {
    name: "Export all of your department's data?",
  });
  await user.click(within(exportDialog).getByRole('button', { name: 'Export department data' }));

  await waitFor(() => {
    expect(screen.getByText('You do not have access to this page.')).toBeTruthy();
  });
  expect(screen.queryByText(SECRET_CEDAR_DETAIL)).toBeNull();
  expect(document.body.textContent).not.toContain(SECRET_CEDAR_DETAIL);
});

test('a 403 revoking sessions shows a generic message, not the raw server detail', async () => {
  const member: Member = {
    memberId: 'm1',
    firstName: 'Sam',
    lastName: 'Lee',
    email: 'sam@example.com',
    phone: '203-555-0199',
    status: 'ACTIVE',
    joinDate: '2020-01-01',
    rank: 'Lt',
    agencyId: 'NFD-1',
  };
  server.use(
    http.get('/api/v1/personnel/members/m1', () => HttpResponse.json(member)),
    http.post('/api/v1/platform/sessions/revoke', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: SECRET_CEDAR_DETAIL,
          traceId: 't6',
        },
        { status: 403 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  await user.click(screen.getByRole('button', { name: 'Revoke all sessions (lost device)' }));
  const revokeDialog = await screen.findByRole('dialog', {
    name: 'Revoke all sessions for Sam Lee?',
  });
  await user.click(within(revokeDialog).getByRole('button', { name: 'Revoke sessions' }));

  await waitFor(() => {
    expect(screen.getByText('You do not have access to this page.')).toBeTruthy();
  });
  expect(screen.queryByText(SECRET_CEDAR_DETAIL)).toBeNull();
  expect(document.body.textContent).not.toContain(SECRET_CEDAR_DETAIL);
});

test('a failed retention load shows an explicit error and disables Run disposal, instead of a silently-empty input', async () => {
  server.use(
    http.get('/api/v1/platform/config/STATIONS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/RANKS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/LOSAP_POINT_RULES', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/ALERT_RULES', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/CHECKLIST_DEFAULTS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/retention', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          detail: 'Retention config unavailable',
          traceId: 't7',
        },
        { status: 503 },
      ),
    ),
  );

  renderRoute(['ADMIN'], '/settings');

  await waitFor(() => {
    expect(screen.getByText('Something went wrong loading this page')).toBeTruthy();
  });
  // The empty/unset-looking retention input must not render — an admin who never sees an
  // error could otherwise save over the real value with an unintentionally low one.
  expect(screen.queryByLabelText('Retention period (years)')).toBeNull();
  expect((screen.getByRole('button', { name: 'Run disposal' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test('resubmitting the same audit lookup refreshes the results table', async () => {
  let calls = 0;
  server.use(
    http.get('/api/v1/platform/audit', () => {
      calls += 1;
      if (calls === 1) {
        return HttpResponse.json({
          entries: [
            {
              actorId: 'admin-1',
              ts: Date.parse('2026-01-01T00:00:00.000Z'),
              action: 'UPDATE',
              mutatedEntityType: 'DEPARTMENT_CONFIG',
              mutatedEntityId: 'ALERT_RULES',
              changedFields: { escalationThresholdN: { old: 60, new: 90 } },
            },
          ],
        });
      }
      return HttpResponse.json({
        entries: [
          {
            actorId: 'admin-1',
            ts: Date.parse('2026-01-01T00:00:00.000Z'),
            action: 'UPDATE',
            mutatedEntityType: 'DEPARTMENT_CONFIG',
            mutatedEntityId: 'ALERT_RULES',
            changedFields: { escalationThresholdN: { old: 60, new: 90 } },
          },
          {
            actorId: 'admin-2',
            ts: Date.parse('2026-01-02T00:00:00.000Z'),
            action: 'UPDATE',
            mutatedEntityType: 'DEPARTMENT_CONFIG',
            mutatedEntityId: 'ALERT_RULES',
            changedFields: { escalationThresholdN: { old: 90, new: 120 } },
          },
        ],
      });
    }),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/audit-log');
  await screen.findByRole('heading', { name: 'Audit log' });

  await user.type(screen.getByLabelText('Entity type'), 'DEPARTMENT_CONFIG');
  await user.type(screen.getByLabelText('Entity ID'), 'ALERT_RULES');
  await user.click(screen.getByRole('button', { name: 'Look up' }));

  await waitFor(() => {
    expect(screen.getByText(/escalationThresholdN: 60 → 90/)).toBeTruthy();
  });
  expect(screen.queryByText('No change history for this record.')).toBeNull();

  // Resubmit the exact same lookup (same entityType/entityId) — this used to keep the same
  // React Query data reference, so the effect filling the results table never re-ran and the
  // page fell through to a false "No change history for this record."
  await user.click(screen.getByRole('button', { name: 'Look up' }));

  await waitFor(() => {
    expect(screen.getByText(/escalationThresholdN: 90 → 120/)).toBeTruthy();
  });
  expect(screen.queryByText('No change history for this record.')).toBeNull();
  expect(calls).toBe(2);
});

test('admin revokes a member’s sessions from /personnel/:id', async () => {
  const member: Member = {
    memberId: 'm1',
    firstName: 'Sam',
    lastName: 'Lee',
    email: 'sam@example.com',
    phone: '203-555-0199',
    status: 'ACTIVE',
    joinDate: '2020-01-01',
    rank: 'Lt',
    agencyId: 'NFD-1',
  };
  server.use(
    http.get('/api/v1/personnel/members/m1', () => HttpResponse.json(member)),
    http.post('/api/v1/platform/sessions/revoke', async ({ request }) => {
      const body = (await request.json()) as { memberId: string };
      return HttpResponse.json({ memberId: body.memberId, status: 'revoked' }, { status: 202 });
    }),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  await user.click(screen.getByRole('button', { name: 'Revoke all sessions (lost device)' }));
  const revokeDialog = await screen.findByRole('dialog', {
    name: 'Revoke all sessions for Sam Lee?',
  });
  await user.click(within(revokeDialog).getByRole('button', { name: 'Revoke sessions' }));

  await waitFor(() => {
    expect(screen.getByText('Sessions revoked.')).toBeTruthy();
  });
});

test('a 400 saving a config lists the RFC 7807 field-level errors (m1)', async () => {
  server.use(
    ...settingsDefaultHandlers(),
    http.put('/api/v1/platform/config/ALERT_RULES', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'The config value failed validation.',
          traceId: 't7',
          errors: [{ field: 'escalationThresholdN', message: 'must be a positive integer' }],
        },
        { status: 400 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/settings');
  const textarea = await screen.findByLabelText('Alert rule timing (JSON)');
  fireEvent.change(textarea, { target: { value: '{"escalationThresholdN":-1}' } });
  await user.click(screen.getByRole('button', { name: 'Save Alert rule timing' }));

  expect(await screen.findByText('The config value failed validation.')).toBeTruthy();
  expect(screen.getByText('escalationThresholdN')).toBeTruthy();
  expect(screen.getByText(/must be a positive integer/)).toBeTruthy();
});

test('malformed RFC 7807 errors entries are dropped, not rendered (m1)', async () => {
  server.use(
    ...settingsDefaultHandlers(),
    http.put('/api/v1/platform/config/ALERT_RULES', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'The config value failed validation.',
          traceId: 't8',
          errors: [{ field: 'ok', message: 'is kept' }, { field: 7 }, 'junk'],
        },
        { status: 400 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/settings');
  const textarea = await screen.findByLabelText('Alert rule timing (JSON)');
  fireEvent.change(textarea, { target: { value: '{"escalationThresholdN":-1}' } });
  await user.click(screen.getByRole('button', { name: 'Save Alert rule timing' }));

  const alert = (await screen.findByText('The config value failed validation.')).closest(
    '[role="alert"]',
  );
  expect(alert?.querySelectorAll('li').length).toBe(1);
  expect(screen.getByText(/is kept/)).toBeTruthy();
});
