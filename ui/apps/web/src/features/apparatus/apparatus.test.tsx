import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { ApparatusDetailPage, defectPhotoSrc } from './ApparatusDetailPage';
import { ApparatusListPage } from './ApparatusListPage';
import type { Apparatus } from './types';

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

function renderApp(groups: string[], path = '/apparatus') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/apparatus"
              element={
                <RequireRole>
                  <ApparatusListPage />
                </RequireRole>
              }
            />
            <Route
              path="/apparatus/:id"
              element={
                <RequireRole>
                  <ApparatusDetailPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('APPARATUS create form adds a unit as IN_SERVICE', async () => {
  const items: Apparatus[] = [];
  server.use(
    http.get('/api/v1/apparatus', () => HttpResponse.json({ apparatus: items })),
    http.post('/api/v1/apparatus', async ({ request }) => {
      const body = (await request.json()) as { unitId: string; type: string };
      const created: Apparatus = {
        apparatusId: 'a-new',
        unitId: body.unitId,
        type: body.type,
        status: 'IN_SERVICE',
      };
      items.push(created);
      return HttpResponse.json(created, { status: 201 });
    }),
  );

  const user = userEvent.setup();
  renderApp(['APPARATUS']);
  await screen.findByRole('heading', { name: 'Apparatus' });
  await user.type(screen.getByLabelText('Unit ID'), 'E1');
  await user.type(screen.getByLabelText('Type'), 'Engine');
  await user.click(screen.getByRole('button', { name: 'Create apparatus' }));
  await waitFor(() => {
    expect(screen.getByText('E1')).toBeTruthy();
    expect(screen.getByText('In service')).toBeTruthy();
  });
});

test('CHIEF can open registry but does not see create control', async () => {
  server.use(http.get('/api/v1/apparatus', () => HttpResponse.json({ apparatus: [] })));

  renderApp(['CHIEF']);
  await screen.findByRole('heading', { name: 'Apparatus' });
  expect(screen.queryByRole('form', { name: 'Create apparatus' })).toBeNull();
});

test('ADMIN cannot open /apparatus under §7.1 RequireRole', async () => {
  renderApp(['ADMIN']);
  await screen.findByRole('heading', { name: 'Forbidden' });
  expect(screen.queryByRole('form', { name: 'Create apparatus' })).toBeNull();
});

test('detail shows status badge shell', async () => {
  server.use(
    http.get('/api/v1/apparatus/L1', () =>
      HttpResponse.json({
        apparatusId: 'a1',
        unitId: 'L1',
        type: 'Ladder',
        status: 'OUT_OF_SERVICE',
        openDefects: [],
        failedTests: [],
      }),
    ),
  );

  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  expect(screen.getByText(/Out of service/i)).toBeTruthy();
});

test('detail renders the OOS reason and elapsed time from the real backend nested outOfService shape', async () => {
  server.use(
    http.get('/api/v1/apparatus/L1', () =>
      HttpResponse.json({
        apparatusId: 'a1',
        unitId: 'L1',
        type: 'Ladder',
        status: 'OUT_OF_SERVICE',
        // Real API shape (apparatus-service repository.ts ApparatusListItem.outOfService) —
        // never the flat oosReason/oosSince fields.
        outOfService: { reason: 'Aerial hydraulic leak', startAt: 0, elapsedSeconds: 2 * 86400 },
        openDefects: [],
        failedTests: [],
      }),
    ),
  );

  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  expect(await screen.findByText(/Aerial hydraulic leak since 2 days ago/i)).toBeTruthy();
});

// apparatusId ('a1') and unitId ('L1') are deliberately different strings in these tests so a
// tab that's handed the wrong identifier fails to match anything, instead of accidentally
// passing because the two happened to be equal. The detail route and GET are keyed on unitId
// (backend getApparatus.ts resolves GET /apparatus/{unitId} by unitId).
function mockDetail() {
  return http.get('/api/v1/apparatus/L1', () =>
    HttpResponse.json({
      apparatusId: 'a1',
      unitId: 'L1',
      type: 'Ladder',
      status: 'IN_SERVICE',
      openDefects: [],
      failedTests: [],
    }),
  );
}

test('SCBA tab filters the due-soon list by apparatusId, matching the page detail fetch (finding #3/#4)', async () => {
  server.use(
    mockDetail(),
    http.get('/api/v1/apparatus/scba/testing-schedules', () =>
      HttpResponse.json({
        dueSoon: [
          {
            apparatusId: 'a1',
            scbaUnitId: 'SCBA-1',
            cylinderId: 'C-1',
            testType: 'SCBA_FLOW',
            dueDate: '2026-10-01',
          },
          {
            apparatusId: 'a-other',
            scbaUnitId: 'SCBA-9',
            cylinderId: 'C-9',
            testType: 'SCBA_FLOW',
            dueDate: '2026-10-01',
          },
        ],
      }),
    ),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  await user.click(screen.getByRole('tab', { name: 'SCBA' }));

  expect(await screen.findByText(/SCBA-1/)).toBeTruthy();
  expect(screen.queryByText(/SCBA-9/)).toBeNull();
});

test('Testing tab filters the schedule by the display unitId, which is what the backend testing-schedules endpoint returns (finding #4)', async () => {
  server.use(
    mockDetail(),
    http.get('/api/v1/apparatus/testing-schedules', () =>
      HttpResponse.json([
        { unitId: 'L1', testType: 'HOSE', nextDueDate: '2026-11-01' },
        { unitId: 'other-unit', testType: 'PUMP', nextDueDate: '2026-11-05' },
      ]),
    ),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  await user.click(screen.getByRole('tab', { name: 'Testing' }));

  expect(await screen.findByText(/HOSE due 2026-11-01/)).toBeTruthy();
  // "PUMP" alone also matches an <option> in the unrelated "Log test record" select below, so
  // assert on the schedule-list wording specifically.
  expect(screen.queryByText(/PUMP due 2026-11-05/)).toBeNull();
});

test('Maintenance tab fetches from the apparatusId-keyed endpoint, matching the page detail fetch (finding #4)', async () => {
  server.use(
    mockDetail(),
    http.get('/api/v1/apparatus/a1/maintenance', () =>
      HttpResponse.json({
        records: [
          {
            apparatusId: 'a1',
            performedAt: 1700000000,
            description: 'Oil change',
            vendor: 'Acme',
            cost: 120,
            scheduledNextAt: null,
          },
        ],
        nextScheduled: null,
      }),
    ),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  await user.click(screen.getByRole('tab', { name: 'Maintenance' }));

  expect(await screen.findByText('Oil change')).toBeTruthy();
});

test('logging maintenance with a next-scheduled date sends scheduledNextAt', async () => {
  let capturedBody: { scheduledNextAt?: number | null } | undefined;
  server.use(
    mockDetail(),
    http.get('/api/v1/apparatus/a1/maintenance', () =>
      HttpResponse.json({ records: [], nextScheduled: null }),
    ),
    http.post('/api/v1/apparatus/a1/maintenance', async ({ request }) => {
      capturedBody = (await request.json()) as { scheduledNextAt?: number | null };
      return HttpResponse.json(
        {
          apparatusId: 'a1',
          performedAt: 1700000000,
          description: 'Brake service',
          vendor: 'Acme',
          cost: 200,
          scheduledNextAt: capturedBody.scheduledNextAt ?? null,
        },
        { status: 201 },
      );
    }),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  await user.click(screen.getByRole('tab', { name: 'Maintenance' }));

  await user.type(await screen.findByLabelText('Description'), 'Brake service');
  await user.type(screen.getByLabelText('Vendor'), 'Acme');
  await user.type(screen.getByLabelText('Cost'), '200');
  await user.type(screen.getByLabelText(/Next scheduled/), '2026-12-01');
  await user.click(screen.getByRole('button', { name: 'Log maintenance' }));

  await waitFor(() => expect(capturedBody?.scheduledNextAt).toBeTypeOf('number'));
});

test('open defects render the photo from the signed URL and ignore a bare S3 key', async () => {
  const signed = 'https://assets.example/NICHOLS/defect/DEF-1/tire.jpg?Signature=abc&Key-Pair-Id=k';
  server.use(
    http.get('/api/v1/apparatus/L1', () =>
      HttpResponse.json({
        apparatusId: 'a1',
        unitId: 'L1',
        type: 'Engine',
        status: 'IN_SERVICE',
        openDefects: [
          {
            defectId: 'DEF-1',
            description: 'Low tire pressure, rear axle',
            severity: 'MAJOR',
            reportedAt: 1700000000,
            photoS3Key: 'NICHOLS/defect/DEF-1/tire.jpg',
            photoUrl: signed,
          },
          {
            defectId: 'DEF-2',
            description: 'Marker light out',
            severity: 'MINOR',
            reportedAt: 1700001000,
            photoS3Key: 'NICHOLS/defect/DEF-2/light.jpg',
            photoUrl: null,
          },
        ],
        failedTests: [],
      }),
    ),
  );

  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });

  const photo = await screen.findByRole('img', { name: 'Low tire pressure, rear axle' });
  expect(photo.getAttribute('src')).toBe(signed);
  expect(screen.getByText('Major')).toBeTruthy();
  expect(
    screen.getByText('Photo on file. The apparatus record did not include a signed photo URL.'),
  ).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Marker light out' })).toBeNull();
  expect(
    defectPhotoSrc({
      defectId: 'DEF-2',
      description: 'Marker light out',
      severity: 'MINOR',
      reportedAt: 0,
      photoS3Key: 'NICHOLS/defect/DEF-2/light.jpg',
    }),
  ).toBeNull();
});

test('the apparatus due-soon panel lists a unit inside the reminder window and omits one outside it', async () => {
  const now = Math.floor(Date.now() / 1000);
  server.use(
    http.get('/api/v1/apparatus', () =>
      HttpResponse.json({
        apparatus: [
          { apparatusId: 'a1', unitId: 'Engine 301', type: 'Engine', status: 'IN_SERVICE' },
          { apparatusId: 'a2', unitId: 'Truck 304', type: 'Ladder', status: 'IN_SERVICE' },
        ],
      }),
    ),
    http.get('/api/v1/apparatus/a1/maintenance', () =>
      HttpResponse.json({ records: [], nextScheduled: now + 10 * 86400 }),
    ),
    http.get('/api/v1/apparatus/a2/maintenance', () =>
      HttpResponse.json({ records: [], nextScheduled: now + 200 * 86400 }),
    ),
  );

  renderApp(['CHIEF']);
  await screen.findByRole('heading', { name: 'Apparatus' });

  expect(await screen.findByText(/Engine 301: due/)).toBeTruthy();
  expect(screen.queryByText(/Truck 304: due/)).toBeNull();
});

test('registry links each unit to its unitId-keyed detail route, not the apparatusId (C2)', async () => {
  server.use(
    http.get('/api/v1/apparatus', () =>
      HttpResponse.json({
        apparatus: [
          { apparatusId: 'a1', unitId: 'Engine 301', type: 'Engine', status: 'IN_SERVICE' },
        ],
      }),
    ),
    http.get('/api/v1/apparatus/a1/maintenance', () =>
      HttpResponse.json({ records: [], nextScheduled: null }),
    ),
  );

  renderApp(['CHIEF']);
  const link = await screen.findByRole('link', { name: 'Engine 301' });
  expect(link.getAttribute('href')).toBe('/apparatus/Engine%20301');
});

test('SCBA records post to the unitId-keyed route the backend resolves (C2)', async () => {
  let postedPath: string | undefined;
  server.use(
    mockDetail(),
    http.get('/api/v1/apparatus/scba/testing-schedules', () => HttpResponse.json({ dueSoon: [] })),
    http.post('/api/v1/apparatus/:unitId/scba', async ({ request, params }) => {
      postedPath = String(params.unitId);
      const body = (await request.json()) as Record<string, string>;
      return HttpResponse.json(
        {
          apparatusId: 'a1',
          ...body,
          nextFlowTestDue: '2027-01-01',
          nextHydroTestDue: '2031-01-01',
        },
        { status: 201 },
      );
    }),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  await user.click(screen.getByRole('tab', { name: 'SCBA' }));
  await user.type(await screen.findByLabelText('SCBA unit'), 'SCBA-1');
  await user.type(screen.getByLabelText('Cylinder ID'), 'C-1');
  await user.type(screen.getByLabelText('Flow test date'), '2026-01-01');
  await user.type(screen.getByLabelText('Hydro test date'), '2026-01-01');
  await user.click(screen.getByRole('button', { name: 'Save SCBA record' }));

  await waitFor(() => expect(postedPath).toBe('L1'));
});

test('service-status changes go to the unitId-keyed route (C2)', async () => {
  let putPath: string | undefined;
  server.use(
    mockDetail(),
    http.put('/api/v1/apparatus/:unitId/service-status', ({ params }) => {
      putPath = String(params.unitId);
      return new HttpResponse(null, { status: 204 });
    }),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  await user.type(screen.getByLabelText('Reason'), 'Pump failure');
  await user.click(screen.getByRole('button', { name: 'Place out of service' }));

  await waitFor(() => expect(putPath).toBe('L1'));
});

test('Inventory quantity edits PUT to /inventory/{itemId} and surface a failed save (M2)', async () => {
  let putPath: string | undefined;
  server.use(
    mockDetail(),
    http.get('/api/v1/apparatus/a1/inventory', () =>
      HttpResponse.json({
        compartments: [
          { compartmentCode: 'C1', items: [{ itemId: 'i1', itemName: 'Halligan', quantity: 2 }] },
        ],
      }),
    ),
    http.put('/api/v1/apparatus/a1/inventory/:itemId', ({ params }) => {
      putPath = `inventory/${String(params.itemId)}`;
      return HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      );
    }),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  await user.click(screen.getByRole('tab', { name: 'Inventory' }));
  const input = await screen.findByLabelText('Quantity for Halligan');
  await user.clear(input);
  await user.type(input, '5');
  await user.tab();

  expect(await screen.findByText(/Quantity not saved/)).toBeTruthy();
  expect(putPath).toBe('inventory/i1');
  expect((screen.getByLabelText('Quantity for Halligan') as HTMLInputElement).value).toBe('2');
});

test('a failed SCBA due-soon read is shown inline and keeps the log form usable (M3)', async () => {
  server.use(
    mockDetail(),
    http.get('/api/v1/apparatus/scba/testing-schedules', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/apparatus/L1');
  await screen.findByRole('heading', { name: 'L1' });
  await user.click(screen.getByRole('tab', { name: 'SCBA' }));

  expect(await screen.findByText('The SCBA due-soon list could not be loaded.')).toBeTruthy();
  expect(screen.getByRole('form', { name: 'Log SCBA record' })).toBeTruthy();
});
