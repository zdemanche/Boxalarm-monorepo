import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildBridgeOutboxRecord } from '../platformBusBridge.js';
import type { DispatchReceived, SourceSystem } from './dispatchIngressPort.js';
import { logError, logInfo } from './logger.js';

export interface CreateManualDispatchInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatch: DispatchReceived;
  readonly idempotencyKey: string;
  readonly dispatchedAt: number;
  readonly targetMemberId?: string;
  readonly selfTestId?: string;
  readonly channelsTested?: readonly string[];
}

export type CreateManualDispatchResult =
  { readonly outcome: 'created'; readonly dispatchId: string } | { readonly outcome: 'duplicate' };

const LOCK_ITEM_INDEX = 0;
const TEST_AUDIT_TTL_SECONDS = 60 * 60 * 24 * 365;

function mintDispatchId(
  deptId: VerifiedDeptId,
  dispatchedAt: number,
  sourceSystem: SourceSystem,
): string {
  const kind = sourceSystem === 'SELF_TEST' ? 'SELFTEST' : 'MANUAL';
  return `${deptId}-${kind}-${dispatchedAt}-${randomUUID().slice(0, 8)}`;
}

export async function createManualDispatch(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: CreateManualDispatchInput,
): Promise<CreateManualDispatchResult> {
  const { deptId, dispatch, idempotencyKey, dispatchedAt } = input;
  const dispatchId = mintDispatchId(deptId, dispatchedAt, dispatch.sourceSystem);
  const isTest = dispatch.sourceSystem === 'SELF_TEST';

  const command = new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: buildDeptScopedPk(
              deptId,
              'DISPATCH_IDEMPOTENCY',
              dispatch.sourceSystem,
              dispatch.externalDispatchId,
            ),
            sk: 'LOCK',
            entityType: 'DISPATCH_IDEMPOTENCY_LOCK',
            idempotencyKey,
            dispatchId,
            deptId,
            createdAt: dispatchedAt,
          },
          ConditionExpression: 'attribute_not_exists(idempotencyKey)',
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
            sk: 'METADATA',
            entityType: 'DISPATCH_ALERT',
            dispatchId,
            deptId,
            sourceSystem: dispatch.sourceSystem,
            incidentType: dispatch.incidentType,
            address: dispatch.address,
            crossStreets: dispatch.crossStreets,
            unitsRequested: dispatch.unitsRequested,
            narrative: dispatch.narrative,
            idempotencyKey,
            dispatchedAt,
            createdAt: dispatchedAt,
            toneLadderStatus: 'ACTIVE',
            currentToneSequence: 1,
            nextToneAt: null,
            isTest,
            ...(input.targetMemberId ? { targetMemberId: input.targetMemberId } : {}),
            ...(input.selfTestId ? { selfTestId: input.selfTestId } : {}),
            ...(input.channelsTested ? { channelsTested: input.channelsTested } : {}),
            ...(isTest
              ? { ttl: dispatchedAt + TEST_AUDIT_TTL_SECONDS }
              : { gsi2pk: buildDeptScopedPk(deptId), gsi2sk: `DISPATCH#${dispatchedAt}` }),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      // INVARIANT: every writer of a non-test DISPATCH_ALERT must emit
      // dispatch.alert.received in the SAME transaction. This function is the only
      // DISPATCH_ALERT writer today (MANUAL, CAD, SELF_TEST all come through here),
      // despite its name. A future ingress path (e.g. /ingress/{adapter}) that writes
      // DISPATCH_ALERT any other way would silently skip the platform-bus bridge,
      // so the alert pages but no incident draft is ever pre-populated. SELF_TEST is
      // excluded on purpose: a member self-test must never reach the LOB bus.
      ...(isTest
        ? []
        : [
            {
              Put: {
                TableName: tableName,
                Item: buildBridgeOutboxRecord(deptId, 'dispatch.alert.received', dispatchId, {
                  deptId,
                  dispatchId,
                  incidentType: dispatch.incidentType,
                  address: dispatch.address,
                  crossStreets: dispatch.crossStreets,
                  narrative: dispatch.narrative,
                  dispatchedAt,
                }),
              },
            },
          ]),
    ],
  });

  try {
    await client.send(command);
    return { outcome: 'created', dispatchId };
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const lockReason = error.CancellationReasons?.[LOCK_ITEM_INDEX];
      if (lockReason?.Code === 'ConditionalCheckFailed') {
        logInfo('dispatches.create.duplicate', {
          deptId,
          externalDispatchId: dispatch.externalDispatchId,
          cancellationReasons: error.CancellationReasons,
        });
        return { outcome: 'duplicate' };
      }
    }
    logError('dispatches.create.failed', error, {
      deptId,
      externalDispatchId: dispatch.externalDispatchId,
    });
    throw error;
  }
}

export interface DispatchAlertItem {
  readonly dispatchId: string;
  // TODO(E1-S2): joined onto DISPATCH_ALERT by fan-out ingress (architecture Backend
  // §1.4); createManualDispatch below does not write it — no ingress path in this repo
  // does yet.
  readonly occupancyId?: string;
}

export class DispatchLookupDependencyError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB is unavailable or returned an unexpected error');
    this.name = 'DispatchLookupDependencyError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export async function getDispatchById(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<DispatchAlertItem | undefined> {
  try {
    const output = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: 'METADATA' },
      }),
    );
    return output.Item as DispatchAlertItem | undefined;
  } catch (error) {
    logError('dispatches.get.failed', error, { deptId, dispatchId });
    throw new DispatchLookupDependencyError(error);
  }
}
