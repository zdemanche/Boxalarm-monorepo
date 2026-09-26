import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { putIncidentSecondary, queryIncidentSecondaries } from './secondaryRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE_NAME = 'boxalarm-dev-incident';
const TRACE_ID = 'trace-abc-123';

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('secondaryRepository', () => {
  it('writes an INCIDENT_SECONDARY item keyed by secondaryType with affected members (E6-S6 AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});

    await putIncidentSecondary(
      fakeClient(send),
      TABLE_NAME,
      DEPT_ID,
      {
        incidentId: 'NICHOLS-4471-1798000000',
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['MBR-0034'],
        updatedAt: 1,
      },
      TRACE_ID,
    );

    const [command] = send.mock.calls[0] as [
      { input: { TransactItems: Array<{ Put: { Item: Record<string, unknown> } }> } },
    ];
    expect(command.input.TransactItems[0]?.Put.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
      sk: 'SECONDARY#EXPOSURE',
      entityType: 'INCIDENT_SECONDARY',
      secondaryType: 'EXPOSURE',
      affectedMemberIds: ['MBR-0034'],
    });
  });

  it('writes an incident.secondary.updated OUTBOX_ENTRY in the same transaction', async () => {
    const send = vi.fn().mockResolvedValue({});

    await putIncidentSecondary(
      fakeClient(send),
      TABLE_NAME,
      DEPT_ID,
      {
        incidentId: 'NICHOLS-4471-1798000000',
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['MBR-0034'],
        updatedAt: 1,
      },
      TRACE_ID,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [
      { input: { TransactItems: Array<{ Put: { Item: Record<string, unknown> } }> } },
    ];
    expect(command.input.TransactItems[1]?.Put.Item).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'incident.secondary.updated',
      source: 'incident-service',
      correlationId: TRACE_ID,
      payload: {
        incidentId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        secondaryType: 'EXPOSURE',
        affectedMemberIds: ['MBR-0034'],
      },
    });
  });

  it('refuses a secondaryType or incidentId containing the key delimiter without writing', async () => {
    const send = vi.fn().mockResolvedValue({});
    const base = {
      incidentId: 'NICHOLS-4471-1798000000',
      secondaryType: 'EXPOSURE',
      payload: {},
      affectedMemberIds: [],
      updatedAt: 1,
    };

    await expect(
      putIncidentSecondary(
        fakeClient(send),
        TABLE_NAME,
        DEPT_ID,
        { ...base, secondaryType: 'EXPOSURE#X' },
        TRACE_ID,
      ),
    ).rejects.toThrow(/secondaryType/);
    await expect(
      putIncidentSecondary(
        fakeClient(send),
        TABLE_NAME,
        DEPT_ID,
        { ...base, incidentId: 'A#B' },
        TRACE_ID,
      ),
    ).rejects.toThrow(/incidentId/);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns each Secondary module as its own distinct item (E6-S6 AC3)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { sk: 'SECONDARY#EXPOSURE', secondaryType: 'EXPOSURE' },
        { sk: 'SECONDARY#RESPONDER_SAFETY', secondaryType: 'RESPONDER_SAFETY' },
      ],
    });

    const results = await queryIncidentSecondaries(
      fakeClient(send),
      TABLE_NAME,
      DEPT_ID,
      'NICHOLS-4471-1798000000',
    );

    expect(results.map((item) => item.secondaryType)).toEqual(['EXPOSURE', 'RESPONDER_SAFETY']);
  });
});
