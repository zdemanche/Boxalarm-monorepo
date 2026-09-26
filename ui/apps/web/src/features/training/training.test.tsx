import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { CertificationsPage } from './CertificationsPage';
import { CertificationsPanel } from './CertificationsPanel';
import { TrainingEventsPage } from './TrainingEventsPage';
import { TranscriptPanel } from './TranscriptPanel';
import type { Certification, TrainingEvent } from './types';

const server = setupServer();
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
    profile: { sub: 'training-1', 'cognito:groups': groups },
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

function renderPage(element: React.ReactElement, groups: string[], path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={path} element={<RequireRole>{element}</RequireRole>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function renderPanel(element: React.ReactElement, groups: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>{element}</AuthProvider>
    </QueryClientProvider>,
  );
}

test('training officer sees the expiring tab sorted by expiry date', async () => {
  server.use(
    http.get('/api/v1/training/certifications/expiring', () =>
      HttpResponse.json([
        {
          certId: 'CERT-2',
          memberId: 'm-2',
          certType: 'Hazmat',
          expiryDate: '2026-02-01',
          issuingAuthority: 'CT DESPP',
          status: 'CURRENT',
        },
        {
          certId: 'CERT-1',
          memberId: 'm-1',
          certType: 'FF1',
          expiryDate: '2026-01-01',
          issuingAuthority: 'CT DESPP',
          status: 'CURRENT',
        },
      ]),
    ),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  const user = userEvent.setup();
  renderPage(<CertificationsPage />, ['TRAINING'], '/certifications');
  await screen.findByRole('heading', { name: 'Certifications' });
  await user.click(screen.getByRole('tab', { name: 'Expiring' }));

  const rows = await screen.findAllByRole('row');
  expect(rows[1]?.textContent).toContain('FF1');
  expect(rows[2]?.textContent).toContain('Hazmat');
});

test('expiring tab renders an empty state instead of an error when none are due', async () => {
  server.use(
    http.get('/api/v1/training/certifications/expiring', () => HttpResponse.json([])),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  const user = userEvent.setup();
  renderPage(<CertificationsPage />, ['TRAINING'], '/certifications');
  await screen.findByRole('heading', { name: 'Certifications' });
  await user.click(screen.getByRole('tab', { name: 'Expiring' }));

  expect(
    await screen.findByText('No certifications are due to expire within the configured window.'),
  ).toBeTruthy();
});

test('training officer creates an event and it appears in start order; a member can sign up', async () => {
  let events: TrainingEvent[] = [
    {
      eventId: 'evt-1',
      title: 'Ladder drill',
      category: 'Ladders',
      startAt: Date.parse('2026-06-01T18:00:00Z'),
      endAt: Date.parse('2026-06-01T20:00:00Z'),
      signedUp: false,
    },
  ];

  server.use(
    http.get('/api/v1/training/events', () => HttpResponse.json(events)),
    http.post('/api/v1/training/events', async ({ request }) => {
      const body = (await request.json()) as Omit<TrainingEvent, 'eventId' | 'signedUp'>;
      const created: TrainingEvent = { ...body, eventId: 'evt-2', signedUp: false };
      events = [...events, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.post('/api/v1/training/events/:eventId/signup', ({ params }) => {
      events = events.map((e) => (e.eventId === params.eventId ? { ...e, signedUp: true } : e));
      return HttpResponse.json({ eventId: params.eventId }, { status: 201 });
    }),
  );

  const user = userEvent.setup();
  renderPage(<TrainingEventsPage />, ['TRAINING'], '/training/events');
  await screen.findByText('Ladder drill');

  await user.type(screen.getByLabelText('Title'), 'Hose drill');
  await user.type(screen.getByLabelText('Category'), 'Hose');
  await user.type(screen.getByLabelText('Starts'), '2026-07-01T09:00');
  await user.type(screen.getByLabelText('Ends'), '2026-07-01T11:00');
  await user.click(screen.getByRole('button', { name: 'Create event' }));
  await screen.findByText('Hose drill');
  // M9: the date inputs are controlled, so a reset form really is empty and the next create
  // can't pass `required` while posting startAt/endAt = 0.
  await waitFor(() => {
    expect((screen.getByLabelText('Starts') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Ends') as HTMLInputElement).value).toBe('');
  });

  const signUpButtons = screen.getAllByRole('button', { name: 'Sign up' });
  await user.click(signUpButtons[0]!);

  await waitFor(() => {
    expect(screen.getByText(/Signed up/)).toBeTruthy();
  });
});

test('training officer records post-event hours for an attendee via the hours form', async () => {
  const events: TrainingEvent[] = [
    {
      eventId: 'evt-1',
      title: 'Ladder drill',
      category: 'Ladders',
      startAt: Date.parse('2020-01-01T18:00:00Z'),
      endAt: Date.parse('2020-01-01T20:00:00Z'),
      signedUp: false,
    },
  ];

  let recordedBody: unknown;
  server.use(
    http.get('/api/v1/training/events', () => HttpResponse.json(events)),
    http.post('/api/v1/training/events/:eventId/signup', async ({ request }) => {
      const body = (await request.json().catch(() => undefined)) as
        { attendees?: unknown } | undefined;
      if (body?.attendees !== undefined) {
        recordedBody = body;
        return HttpResponse.json({ eventId: 'evt-1', attendeeCount: 1 });
      }
      return HttpResponse.json({ eventId: 'evt-1' }, { status: 201 });
    }),
  );

  const user = userEvent.setup();
  renderPage(<TrainingEventsPage />, ['TRAINING'], '/training/events');
  await screen.findByText('Ladder drill');

  const form = screen.getByRole('form', { name: 'Record hours for Ladder drill' });
  await user.type(within(form).getByLabelText('Member ID'), 'm-1');
  await user.type(within(form).getByLabelText('Hours'), '2');
  await user.click(within(form).getByRole('button', { name: 'Record hours' }));

  await waitFor(() => {
    expect(recordedBody).toEqual({ attendees: [{ memberId: 'm-1', hours: 2 }] });
  });
  await waitFor(() => {
    expect((within(form).getByLabelText('Member ID') as HTMLInputElement).value).toBe('');
  });
});

test('training officer adds a certification and can revoke it; a non-training role has no controls', async () => {
  let certifications: Certification[] = [];

  server.use(
    http.get('/api/v1/training/members/m-1/certifications', () =>
      HttpResponse.json(certifications),
    ),
    http.post('/api/v1/training/members/m-1/certifications', async ({ request }) => {
      const body = (await request.json()) as Omit<
        Certification,
        'certId' | 'memberId' | 'status' | 'attachmentS3Key'
      >;
      const created: Certification = {
        ...body,
        certId: 'CERT-1',
        memberId: 'm-1',
        attachmentS3Key: null,
        status: 'CURRENT',
      };
      certifications = [...certifications, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.post('/api/v1/training/members/m-1/certifications/CERT-1/revoke', () => {
      certifications = certifications.map((c) =>
        c.certId === 'CERT-1' ? { ...c, status: 'REVOKED' } : c,
      );
      return HttpResponse.json(certifications[0]);
    }),
  );

  const user = userEvent.setup();
  renderPanel(<CertificationsPanel memberId="m-1" />, ['TRAINING']);
  await screen.findByRole('heading', { name: 'Certifications' });

  await user.type(screen.getByLabelText('Certification type'), 'FF1');
  await user.type(screen.getByLabelText('Issue date'), '2024-01-01');
  await user.type(screen.getByLabelText('Expiry date'), '2029-01-01');
  await user.type(screen.getByLabelText('Issuing authority'), 'CT DESPP');
  await user.click(screen.getByRole('button', { name: 'Add certification' }));

  await screen.findByText(/FF1/);
  await user.click(screen.getByRole('button', { name: 'Revoke' }));
  const dialog = await screen.findByRole('dialog', { name: 'Revoke FF1?' });
  await user.click(within(dialog).getByRole('button', { name: 'Revoke certification' }));

  await waitFor(() => {
    expect(screen.getByText(/REVOKED/)).toBeTruthy();
  });

  cleanup();
  renderPanel(<CertificationsPanel memberId="m-1" />, ['OFFICER']);
  await screen.findByText(/FF1/);
  expect(screen.queryByRole('form', { name: 'Add certification' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
});

test('a failed revoke stays in the confirm dialog and shows the error (m2)', async () => {
  const cert: Certification = {
    certId: 'CERT-1',
    memberId: 'm-1',
    certType: 'FF1',
    issueDate: '2024-01-01',
    expiryDate: '2029-01-01',
    issuingAuthority: 'CT DESPP',
    attachmentS3Key: null,
    status: 'CURRENT',
  };
  server.use(
    http.get('/api/v1/training/members/m-1/certifications', () => HttpResponse.json([cert])),
    http.post('/api/v1/training/members/m-1/certifications/CERT-1/revoke', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderPanel(<CertificationsPanel memberId="m-1" />, ['TRAINING']);
  await user.click(await screen.findByRole('button', { name: 'Revoke' }));
  const dialog = await screen.findByRole('dialog', { name: 'Revoke FF1?' });
  await user.click(within(dialog).getByRole('button', { name: 'Revoke certification' }));

  expect(await within(dialog).findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Revoke FF1?' })).toBeTruthy();
});

test('failed sign-up and failed hours recording are shown, not swallowed (m2)', async () => {
  const events: TrainingEvent[] = [
    {
      eventId: 'evt-1',
      title: 'Ladder drill',
      category: 'Ladders',
      startAt: Date.parse('2020-01-01T18:00:00Z'),
      endAt: Date.parse('2020-01-01T20:00:00Z'),
      signedUp: false,
    },
  ];
  server.use(
    http.get('/api/v1/training/events', () => HttpResponse.json(events)),
    http.post('/api/v1/training/events/:eventId/signup', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderPage(<TrainingEventsPage />, ['TRAINING'], '/training/events');
  await screen.findByText('Ladder drill');

  await user.click(screen.getByRole('button', { name: 'Sign up' }));
  expect(await screen.findByText(/Sign-up failed/)).toBeTruthy();

  const form = screen.getByRole('form', { name: 'Record hours for Ladder drill' });
  await user.type(within(form).getByLabelText('Member ID'), 'm-1');
  await user.type(within(form).getByLabelText('Hours'), '2');
  await user.click(within(form).getByRole('button', { name: 'Record hours' }));
  expect(await within(form).findByText(/Hours not recorded/)).toBeTruthy();
});

test('a failed transcript export is reported instead of an unhandled rejection (m2)', async () => {
  server.use(
    http.get('/api/v1/training/members/m-1/transcript', ({ request }) => {
      if (new URL(request.url).searchParams.get('format')) {
        return HttpResponse.json(
          { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
          { status: 503 },
        );
      }
      return HttpResponse.json({
        memberId: 'm-1',
        certifications: [],
        attendance: [],
        hoursByCategory: {},
      });
    }),
  );

  const user = userEvent.setup();
  renderPanel(<TranscriptPanel memberId="m-1" />, ['TRAINING']);
  await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

  expect(await screen.findByText('The CSV export failed. Try again.')).toBeTruthy();
});

test('certifications views are a full tabs pattern: tabpanel, aria-controls, arrow keys (m7)', async () => {
  server.use(
    http.get('/api/v1/training/certifications/expiring', () => HttpResponse.json([])),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  const user = userEvent.setup();
  renderPage(<CertificationsPage />, ['TRAINING'], '/certifications');
  const certsTab = await screen.findByRole('tab', { name: 'Certifications' });
  const panel = screen.getByRole('tabpanel');
  expect(certsTab.getAttribute('aria-controls')).toBe(panel.id);

  certsTab.focus();
  await user.keyboard('{ArrowRight}');
  const expiringTab = screen.getByRole('tab', { name: 'Expiring' });
  expect(document.activeElement).toBe(expiringTab);
  expect(expiringTab.getAttribute('aria-selected')).toBe('true');
});
