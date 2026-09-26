import type { DynamoDBBatchResponse, DynamoDBStreamEvent, Handler } from 'aws-lambda';
import { createOutboxDrainHandler, type OutboxDrainClients } from '@boxalarm/outbox';
import { ALERTING_SOURCE, BRIDGE_EVENT_TYPES } from './platformBusBridge.js';

/**
 * Alerting-table outbox -> platform-bus bridge. The shared drain, pinned to the
 * alerting table, a fixed Source (a row cannot claim another service's identity),
 * and the bridge allow-list (anything else is skipped, logged, and counted as
 * EventTypeRejected in Boxalarm/alerting-bridge).
 */
export function createAlertingOutboxDrainHandler(
  overrides: Partial<OutboxDrainClients> = {},
): Handler<DynamoDBStreamEvent, DynamoDBBatchResponse> {
  return createOutboxDrainHandler(ALERTING_SOURCE, overrides, {
    tableNameEnvVar: 'ALERTING_TABLE_NAME',
    source: ALERTING_SOURCE,
    allowedEventTypes: new Set(BRIDGE_EVENT_TYPES),
    metricNamespace: 'Boxalarm/alerting-bridge',
  });
}

export const handler = createAlertingOutboxDrainHandler();
