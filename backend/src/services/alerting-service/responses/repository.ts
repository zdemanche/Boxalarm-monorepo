import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildBridgeOutboxRecord } from '../platformBusBridge.js';
import type { AckStatus } from '../dispatchRosterEntry.js';
import { parseSnapshotItem } from '../eligibility/selector.js';
import { logError, logInfo } from '../dispatches/logger.js';

export type ResponseAckStatus = Exclude<AckStatus, 'NONE'>;

export interface RecordResponseInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly ackStatus: ResponseAckStatus;
  readonly eta: number | null;
  readonly assignedApparatusId: string | null;
  readonly answeredAt: number;
}

export type RecordResponseResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'dispatch-not-found' }
  | { readonly outcome: 'ineligible' };

export async function recordResponse(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: RecordResponseInput,
): Promise<RecordResponseResult> {
  const { deptId, dispatchId, memberId, ackStatus, eta, assignedApparatusId, answeredAt } = input;
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);

  const dispatch = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' } }),
  );
  if (!dispatch.Item) {
    return { outcome: 'dispatch-not-found' };
  }
  const toneSequence = (dispatch.Item.currentToneSequence as number | undefined) ?? 1;

  const eligibility = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'),
        sk: `MEMBER#${memberId}`,
      },
    }),
  );
  const snapshot = parseSnapshotItem(eligibility.Item as Record<string, unknown> | undefined);
  if (!snapshot || !snapshot.active) {
    logInfo('responses.record.ineligible', { deptId, dispatchId, memberId });
    return { outcome: 'ineligible' };
  }

  const isTest = dispatch.Item.isTest === true;

  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk,
              sk: `RESPONSE#${memberId}#${answeredAt}`,
              entityType: 'DISPATCH_RESPONSE_RECORD',
              memberId,
              ackStatus,
              toneSequence,
              eta,
              assignedApparatusId,
              answeredAt,
            },
          },
        },
        ...(isTest
          ? []
          : [
              {
                Put: {
                  TableName: tableName,
                  Item: buildBridgeOutboxRecord(deptId, 'alerting.response.confirmed', dispatchId, {
                    deptId,
                    dispatchId,
                    memberId,
                    status: ackStatus,
                    ackAt: answeredAt,
                  }),
                },
              },
            ]),
      ],
    }),
  );

  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk: `ROSTER#${memberId}` },
        UpdateExpression:
          'SET entityType = :entityType, memberId = :memberId, ackStatus = :ackStatus, ackAt = :ackAt, eta = :eta, assignedApparatusId = :assignedApparatusId, lastAnsweredTone = :toneSequence, quals = :quals',
        ConditionExpression: 'attribute_not_exists(ackAt) OR :ackAt > ackAt',
        ExpressionAttributeValues: {
          ':entityType': 'DISPATCH_ROSTER_ENTRY',
          ':memberId': memberId,
          ':ackStatus': ackStatus,
          ':ackAt': answeredAt,
          ':eta': eta,
          ':assignedApparatusId': assignedApparatusId,
          ':toneSequence': toneSequence,
          ':quals': snapshot.quals,
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      logInfo('responses.record.stale_write_skipped', { deptId, dispatchId, memberId });
      return { outcome: 'recorded' };
    }
    logError('responses.record.roster_update_failed', error, { deptId, dispatchId, memberId });
    throw error;
  }

  return { outcome: 'recorded' };
}
