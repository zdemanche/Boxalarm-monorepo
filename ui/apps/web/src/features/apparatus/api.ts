import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  Apparatus,
  ApparatusDetail,
  ApparatusStatus,
  ChecklistTemplate,
  ComplianceEntry,
  CreateApparatusInput,
  CreateInventoryItemInput,
  CreateMaintenanceInput,
  CreateScbaInput,
  CreateTestRecordInput,
  CompartmentGroup,
  MaintenanceRecord,
  ScbaDueEntry,
  ScbaRecord,
  TestingScheduleEntry,
} from './types';

function unit(unitId: string): string {
  return `apparatus/${encodeURIComponent(unitId)}`;
}

export async function listApparatus(tokens: AuthTokenSource): Promise<Apparatus[]> {
  const response = await apiRequest('apparatus', tokens);
  const body = (await response.json()) as { apparatus: Apparatus[] };
  return body.apparatus;
}

export async function getApparatus(
  tokens: AuthTokenSource,
  apparatusId: string,
): Promise<ApparatusDetail> {
  const response = await apiRequest(unit(apparatusId), tokens);
  return (await response.json()) as ApparatusDetail;
}

export async function createApparatus(
  tokens: AuthTokenSource,
  input: CreateApparatusInput,
): Promise<Apparatus> {
  const response = await apiRequest('apparatus', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as Apparatus;
}

export async function setServiceStatus(
  tokens: AuthTokenSource,
  unitId: string,
  status: ApparatusStatus,
  reason?: string,
): Promise<void> {
  await apiRequest(`${unit(unitId)}/service-status`, tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason ? { status, reason } : { status }),
  });
}

export async function getChecklist(
  tokens: AuthTokenSource,
  unitId: string,
): Promise<ChecklistTemplate> {
  const response = await apiRequest(`${unit(unitId)}/checklist`, tokens);
  return (await response.json()) as ChecklistTemplate;
}

export async function getMaintenance(
  tokens: AuthTokenSource,
  unitId: string,
): Promise<{ records: MaintenanceRecord[]; nextScheduled: number | null }> {
  const response = await apiRequest(`${unit(unitId)}/maintenance`, tokens);
  return (await response.json()) as { records: MaintenanceRecord[]; nextScheduled: number | null };
}

export async function createMaintenance(
  tokens: AuthTokenSource,
  unitId: string,
  input: CreateMaintenanceInput,
): Promise<MaintenanceRecord> {
  const response = await apiRequest(`${unit(unitId)}/maintenance`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as MaintenanceRecord;
}

export async function createScbaRecord(
  tokens: AuthTokenSource,
  unitId: string,
  input: CreateScbaInput,
): Promise<ScbaRecord> {
  const response = await apiRequest(`${unit(unitId)}/scba`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as ScbaRecord;
}

export async function getScbaDueSoon(
  tokens: AuthTokenSource,
  withinDays?: number,
): Promise<ScbaDueEntry[]> {
  const query = withinDays !== undefined ? `?withinDays=${withinDays}` : '';
  const response = await apiRequest(`apparatus/scba/testing-schedules${query}`, tokens);
  const body = (await response.json()) as { dueSoon: ScbaDueEntry[] };
  return body.dueSoon;
}

export async function createTestRecord(
  tokens: AuthTokenSource,
  unitId: string,
  input: CreateTestRecordInput,
): Promise<void> {
  await apiRequest(`${unit(unitId)}/tests`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function getTestingSchedules(
  tokens: AuthTokenSource,
  monthsAhead?: number,
): Promise<TestingScheduleEntry[]> {
  const query = monthsAhead !== undefined ? `?monthsAhead=${monthsAhead}` : '';
  const response = await apiRequest(`apparatus/testing-schedules${query}`, tokens);
  return (await response.json()) as TestingScheduleEntry[];
}

export async function getInventory(
  tokens: AuthTokenSource,
  unitId: string,
): Promise<CompartmentGroup[]> {
  const response = await apiRequest(`${unit(unitId)}/inventory`, tokens);
  const body = (await response.json()) as { compartments: CompartmentGroup[] };
  return body.compartments;
}

export async function createInventoryItem(
  tokens: AuthTokenSource,
  unitId: string,
  input: CreateInventoryItemInput,
): Promise<void> {
  await apiRequest(`${unit(unitId)}/inventory`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateInventoryQuantity(
  tokens: AuthTokenSource,
  unitId: string,
  itemId: string,
  quantity: number,
): Promise<void> {
  await apiRequest(`${unit(unitId)}/inventory/${encodeURIComponent(itemId)}`, tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity }),
  });
}

export async function getCompliance(
  tokens: AuthTokenSource,
  from: number,
  to: number,
): Promise<ComplianceEntry[]> {
  const response = await apiRequest(`apparatus/compliance?from=${from}&to=${to}`, tokens);
  const body = (await response.json()) as { report: ComplianceEntry[] };
  return body.report;
}
