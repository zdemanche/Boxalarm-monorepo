import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { BRIDGE_OUTBOX_TTL_SECONDS, buildBridgeOutboxRecord } from './platformBusBridge.js';

describe('buildBridgeOutboxRecord', () => {
  it('stamps an epoch-seconds ttl seven days after eventTime so the alerting table TTL reaps the row', () => {
    const record = buildBridgeOutboxRecord(
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
      'dispatch.alert.received',
      'dispatch-1',
      { dispatchId: 'dispatch-1' },
    );
    const eventTimeSeconds = Math.floor(Date.parse(record.eventTime) / 1000);
    expect(BRIDGE_OUTBOX_TTL_SECONDS).toBe(604_800);
    expect(record.ttl).toBe(eventTimeSeconds + BRIDGE_OUTBOX_TTL_SECONDS);
    expect(Number.isInteger(record.ttl)).toBe(true);
  });

  it('writes source alerting-service and the dept-scoped outbox key', () => {
    const record = buildBridgeOutboxRecord(
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
      'alerting.tone.escalated',
      'dispatch-1',
      {},
    );
    expect(record).toMatchObject({
      pk: 'DEPT#NICHOLS#OUTBOX',
      entityType: 'OUTBOX_ENTRY',
      source: 'alerting-service',
      eventType: 'alerting.tone.escalated',
      sentAt: null,
    });
  });
});
