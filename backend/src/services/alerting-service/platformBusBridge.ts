import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord, type OutboxRecord } from '@boxalarm/outbox';

export const ALERTING_SOURCE = 'alerting-service';

/**
 * The one-way alerting -> LOB platform-bus bridge allow-list (architecture spine,
 * "One-way bridge only"). Every alerting OUTBOX_ENTRY must use one of these types:
 * producers are held to it at compile time by buildBridgeOutboxRecord, and the drain
 * (outboxDrainHandler.ts) refuses anything else at runtime, so a future internal
 * alerting event cannot leak across the isolation boundary by being written to the
 * outbox.
 *
 * `dispatch.alert.received` is the name the producer, the LOB-side EventBridge rule,
 * and its consumer all use; the compiled spine spells it `alerting.dispatch.received`.
 */
export const BRIDGE_EVENT_TYPES = [
  'dispatch.alert.received',
  'alerting.response.confirmed',
  'alerting.tone.escalated',
  'alerting.mutual_aid.triggered',
] as const;

export type BridgeEventType = (typeof BRIDGE_EVENT_TYPES)[number];

/**
 * Outbox rows are only a hand-off to the stream-triggered drain (stream retention is
 * 24h), and they duplicate fields that already live permanently on the source item.
 * The alerting table's TTL on `ttl` reaps them after this window; the resulting
 * REMOVE stream records are ignored by every reader.
 */
export const BRIDGE_OUTBOX_TTL_SECONDS = 7 * 24 * 60 * 60;

export type BridgeOutboxRecord<TPayload> = OutboxRecord<TPayload> & { readonly ttl: number };

export function buildBridgeOutboxRecord<TPayload>(
  deptId: VerifiedDeptId,
  eventType: BridgeEventType,
  correlationId: string,
  payload: TPayload,
): BridgeOutboxRecord<TPayload> {
  const record = buildOutboxRecord(deptId, ALERTING_SOURCE, eventType, correlationId, payload);
  const eventTimeSeconds = Math.floor(Date.parse(record.eventTime) / 1000);
  return { ...record, ttl: eventTimeSeconds + BRIDGE_OUTBOX_TTL_SECONDS };
}
