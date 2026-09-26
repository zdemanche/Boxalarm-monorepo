import type { ProblemDetails } from '../../lib/apiClient';
import type {
  Apparatus,
  ApparatusDetail,
  ChecklistTemplate,
  ComplianceEntry,
  CompartmentGroup,
  CreateApparatusInput,
  MaintenanceRecord,
  ScbaDueEntry,
  ScbaRecord,
  TestingScheduleEntry,
} from './types';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, title: string): Response {
  const body: ProblemDetails = { type: 'about:blank', title, status, traceId: 'demo' };
  return json(body, status);
}

// Nichols FD tenant-zero apparatus registry. Real departments' fleets come from the
// per-department API; this is fixture data for the demo build only.
let apparatus: Apparatus[] = [
  { apparatusId: 'a-1', unitId: 'Rescue 300', type: 'Rescue', status: 'IN_SERVICE' },
  { apparatusId: 'a-2', unitId: 'Engine 301', type: 'Engine', status: 'IN_SERVICE' },
  {
    apparatusId: 'a-3',
    unitId: 'Truck 304',
    type: 'Ladder',
    status: 'OUT_OF_SERVICE',
    outOfService: {
      reason: 'Aerial hydraulic leak',
      startAt: Math.floor(Date.now() / 1000) - 2 * 86400,
      // Recomputed live from startAt on every read below (withLiveElapsed), same as the real
      // API — this seed value is just the value at module load.
      elapsedSeconds: 2 * 86400,
    },
  },
  { apparatusId: 'a-4', unitId: 'Engine 305', type: 'Engine', status: 'IN_SERVICE' },
  { apparatusId: 'a-5', unitId: 'Squad 309', type: 'Squad', status: 'IN_SERVICE' },
];

const checklistTemplate: ChecklistTemplate = {
  templateId: 'CT-01',
  name: 'Engine daily check',
  applicableApparatusIds: apparatus.map((a) => a.apparatusId),
  items: [
    { code: 'TIRES', label: 'Tires and wheels', requiresPhoto: false },
    { code: 'FLUIDS', label: 'Fluid levels', requiresPhoto: false },
    { code: 'LIGHTS', label: 'Lights and sirens', requiresPhoto: false },
    { code: 'SCBA', label: 'SCBA units present and charged', requiresPhoto: true },
  ],
};

const maintenanceByUnit = new Map<string, MaintenanceRecord[]>([
  [
    'a-2',
    [
      {
        apparatusId: 'a-2',
        performedAt: Math.floor(Date.now() / 1000) - 60 * 86400,
        description: 'Annual pump service',
        vendor: 'Nichols Fire Apparatus',
        cost: 850,
        scheduledNextAt: Math.floor(Date.now() / 1000) + 14 * 86400,
      },
    ],
  ],
]);
const scbaByUnit = new Map<string, ScbaRecord[]>();
const scbaDueSoon: ScbaDueEntry[] = [];
const testingSchedule: TestingScheduleEntry[] = [];
const inventoryByUnit = new Map<string, CompartmentGroup[]>();

function findByApparatusId(apparatusId: string): Apparatus | undefined {
  return apparatus.find((a) => a.apparatusId === apparatusId);
}

function findByUnitId(unitId: string): Apparatus | undefined {
  return apparatus.find((a) => a.unitId === unitId);
}

// Mirrors which identifier each real apparatus-service handler resolves its `{unitId}` path
// segment by: detail, checklist, service-status, SCBA and test-record writes look the unit up by
// its display unitId (GSI3); maintenance and inventory use the segment directly as the
// apparatusId partition key.
const SUB_RESOURCES_KEYED_BY_APPARATUS_ID = new Set(['maintenance', 'inventory']);

// Mirrors the real backend (repository.ts): elapsedSeconds is derived from startAt at read
// time, not stored, so it stays correct across a long-lived demo session.
function withLiveElapsed(unit: Apparatus): Apparatus {
  if (!unit.outOfService) return unit;
  return {
    ...unit,
    outOfService: {
      ...unit.outOfService,
      elapsedSeconds: Math.max(0, Math.floor(Date.now() / 1000) - unit.outOfService.startAt),
    },
  };
}

const ENGINE_301_TIRE_PHOTO = '/demo/engine-301-tire.svg';

function toDetail(unit: Apparatus): ApparatusDetail {
  const openDefects =
    unit.apparatusId === 'a-2'
      ? [
          {
            defectId: 'DEF-301-TIRE',
            description: 'Low tire pressure, rear axle',
            severity: 'MAJOR' as const,
            reportedAt: Math.floor(Date.now() / 1000) - 2 * 3600,
            photoS3Key: 'NICHOLS/defect/DEF-301-TIRE/tire.jpg',
            photoUrl: ENGINE_301_TIRE_PHOTO,
          },
        ]
      : [];
  return { ...withLiveElapsed(unit), openDefects, failedTests: [] };
}

export async function apparatusDemoRequest(
  path: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Response | undefined> {
  const parts = path.split('/');
  if (parts[0] !== 'apparatus') return undefined;

  if (path === 'apparatus' && method === 'GET') {
    return json({ apparatus: apparatus.map(withLiveElapsed) });
  }

  if (path === 'apparatus' && method === 'POST') {
    const input = body as unknown as CreateApparatusInput;
    const created: Apparatus = {
      apparatusId: `a-${apparatus.length + 1}`,
      unitId: input.unitId,
      type: input.type,
      status: 'IN_SERVICE',
    };
    apparatus = [...apparatus, created];
    return json(created, 201);
  }

  if (path === 'apparatus/testing-schedules' && method === 'GET') {
    return json(testingSchedule);
  }

  if (path === 'apparatus/scba/testing-schedules' && method === 'GET') {
    return json({ dueSoon: scbaDueSoon });
  }

  if (path.startsWith('apparatus/compliance') && method === 'GET') {
    const report: ComplianceEntry[] = apparatus.map((unit) => ({
      unitId: unit.unitId,
      expectedChecks: 7,
      actualChecks: unit.status === 'IN_SERVICE' ? 5 : 0,
      compliant: unit.status === 'IN_SERVICE',
    }));
    return json({ report });
  }

  if (parts.length === 2 && method === 'GET') {
    const unit = findByUnitId(decodeURIComponent(parts[1] ?? ''));
    return unit ? json(toDetail(unit)) : problem(404, 'Apparatus not found');
  }

  const segment = decodeURIComponent(parts[1] ?? '');
  const unit = SUB_RESOURCES_KEYED_BY_APPARATUS_ID.has(parts[2] ?? '')
    ? findByApparatusId(segment)
    : findByUnitId(segment);
  if (!unit) return problem(404, 'Apparatus not found');
  const apparatusId = unit.apparatusId;

  if (parts[2] === 'checklist' && method === 'GET') {
    return json(checklistTemplate);
  }

  if (parts[2] === 'service-status' && method === 'PUT') {
    const status = body.status as Apparatus['status'];
    unit.status = status;
    unit.outOfService =
      status === 'OUT_OF_SERVICE'
        ? {
            reason: body.reason as string,
            startAt: Math.floor(Date.now() / 1000),
            elapsedSeconds: 0,
          }
        : undefined;
    return new Response(null, { status: 204 });
  }

  if (parts[2] === 'maintenance' && method === 'GET') {
    const records = maintenanceByUnit.get(apparatusId) ?? [];
    return json({
      records,
      nextScheduled: records.find((r) => r.scheduledNextAt)?.scheduledNextAt ?? null,
    });
  }

  if (parts[2] === 'maintenance' && method === 'POST') {
    const record: MaintenanceRecord = {
      apparatusId,
      performedAt: Math.floor(Date.now() / 1000),
      description: body.description as string,
      vendor: body.vendor as string,
      cost: body.cost as number,
      scheduledNextAt: (body.scheduledNextAt as number | null | undefined) ?? null,
    };
    maintenanceByUnit.set(apparatusId, [record, ...(maintenanceByUnit.get(apparatusId) ?? [])]);
    return json(record, 201);
  }

  if (parts[2] === 'scba' && method === 'POST') {
    const addDays = (iso: string, days: number) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    const record: ScbaRecord = {
      apparatusId,
      scbaUnitId: body.scbaUnitId as string,
      cylinderId: body.cylinderId as string,
      flowTestDate: body.flowTestDate as string,
      hydroTestDate: body.hydroTestDate as string,
      nextFlowTestDue: addDays(body.flowTestDate as string, 365),
      nextHydroTestDue: addDays(body.hydroTestDate as string, 1825),
    };
    scbaByUnit.set(apparatusId, [record, ...(scbaByUnit.get(apparatusId) ?? [])]);
    return json(record, 201);
  }

  if (parts[2] === 'tests' && method === 'POST') {
    testingSchedule.push({
      unitId: unit.unitId,
      testType: body.testType as TestingScheduleEntry['testType'],
      nextDueDate: body.nextDueDate as string,
    });
    return json({ apparatusId, ...body }, 201);
  }

  if (parts[2] === 'inventory' && parts.length === 3 && method === 'GET') {
    return json({ compartments: inventoryByUnit.get(apparatusId) ?? [] });
  }

  if (parts[2] === 'inventory' && parts.length === 3 && method === 'POST') {
    const compartmentCode = body.compartmentCode as string;
    const groups = inventoryByUnit.get(apparatusId) ?? [];
    let group = groups.find((g) => g.compartmentCode === compartmentCode);
    if (!group) {
      group = { compartmentCode, items: [] };
      groups.push(group);
    }
    const item = {
      itemId: `item-${Date.now()}`,
      itemName: body.itemName as string,
      quantity: body.quantity as number,
    };
    group.items.push(item);
    inventoryByUnit.set(apparatusId, groups);
    return json(item, 201);
  }

  if (parts[2] === 'inventory' && parts.length === 4 && method === 'PUT') {
    const itemId = decodeURIComponent(parts[3] ?? '');
    const groups = inventoryByUnit.get(apparatusId) ?? [];
    for (const group of groups) {
      const item = group.items.find((i) => i.itemId === itemId);
      if (item) {
        item.quantity = body.quantity as number;
        return json({ itemId, quantity: item.quantity });
      }
    }
    return problem(404, 'Inventory item not found');
  }

  return problem(404, 'Not found');
}
