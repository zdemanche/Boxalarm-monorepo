import { expect, test } from 'vitest';
import { apparatusDemoRequest } from './demoFixtures';

// The demo fixture must resolve each path segment by the same identifier the real
// apparatus-service handler does, or the demo hides live-mode 404s (PR #321 review C2).

test('detail GET resolves by display unitId, like backend getApparatus.ts', async () => {
  const byUnitId = await apparatusDemoRequest(
    `apparatus/${encodeURIComponent('Engine 301')}`,
    'GET',
    {},
  );
  expect(byUnitId?.status).toBe(200);
  const byApparatusId = await apparatusDemoRequest('apparatus/a-2', 'GET', {});
  expect(byApparatusId?.status).toBe(404);
});

test('service-status PUT resolves by display unitId', async () => {
  const response = await apparatusDemoRequest(
    `apparatus/${encodeURIComponent('Squad 309')}/service-status`,
    'PUT',
    { status: 'IN_SERVICE' },
  );
  expect(response?.status).toBe(204);
});

test('maintenance and inventory resolve by apparatusId (the partition key)', async () => {
  const maintenance = await apparatusDemoRequest('apparatus/a-2/maintenance', 'GET', {});
  expect(maintenance?.status).toBe(200);
  const inventory = await apparatusDemoRequest('apparatus/a-2/inventory', 'GET', {});
  expect(inventory?.status).toBe(200);
});

test('SCBA POST resolves by unitId and records the resolved apparatusId', async () => {
  const response = await apparatusDemoRequest(
    `apparatus/${encodeURIComponent('Engine 301')}/scba`,
    'POST',
    {
      scbaUnitId: 'SCBA-1',
      cylinderId: 'C-1',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-01-01',
    },
  );
  expect(response?.status).toBe(201);
  expect(((await response?.json()) as { apparatusId: string }).apparatusId).toBe('a-2');
});
