import { randomUUID } from 'node:crypto';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export {
  createOutboxDrainHandler,
  createOutboxDrainClients,
  readOutboxDrainConfig,
  type OutboxDrainClients,
  type OutboxDrainConfig,
  type OutboxDrainOptions,
} from './drainHandler.js';

export interface EventEnvelope<TPayload> {
  readonly eventId: string;
  readonly eventTime: string;
  readonly eventType: string;
  readonly source: string;
  readonly correlationId: string;
  readonly schemaVersion: string;
  readonly payload: TPayload;
}

export type OutboxRecord<TPayload> = Readonly<Record<'pk' | 'sk', string>> &
  EventEnvelope<TPayload> & {
    readonly entityType: 'OUTBOX_ENTRY';
    readonly sentAt: string | null;
  };

export function buildOutboxRecord<TPayload>(
  deptId: VerifiedDeptId,
  source: string,
  eventType: string,
  correlationId: string,
  payload: TPayload,
): OutboxRecord<TPayload> {
  const eventId = randomUUID();
  const eventTime = new Date().toISOString();
  return {
    pk: buildDeptScopedPk(deptId, 'OUTBOX'),
    sk: `EVENT#${eventTime}#${eventId}`,
    entityType: 'OUTBOX_ENTRY',
    eventId,
    eventTime,
    eventType,
    source,
    correlationId,
    schemaVersion: '1.0',
    payload,
    sentAt: null,
  };
}
