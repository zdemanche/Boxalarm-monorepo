import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import {
  parseChannelEnvelope,
  parseMutualAidPromptEnvelope,
  resolveChannelTarget,
  type ChannelEnvelopePayload,
  type ChannelName,
  type ContactChannelSnapshot,
  type MutualAidPromptPayload,
} from './channelEnvelope.js';
import { sendViaHttpProvider } from './httpProviderAdapter.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingChannel';

const CHANNEL_TIER: Record<ChannelName, 'primary' | 'escalation'> = {
  push: 'primary',
  sms: 'primary',
  voice: 'escalation',
};

interface DeliverChannelMessageCommon {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: ChannelName;
  readonly contactChannels: readonly ContactChannelSnapshot[] | undefined;
  readonly message: string;
  readonly env: NodeJS.ProcessEnv;
  /** Self-test/canary message — sent with the sandbox provider credentials. */
  readonly isTest?: boolean;
}

/**
 * A dispatch page is guarded per tone; a mutual-aid prompt carries no toneSequence and is
 * guarded in its own MAPROMPT# namespace (architecture §3.1 "Officer push item shape") so it
 * never collides with the tone-3 receipt an officer already holds.
 */
export type DeliverChannelMessageParams = DeliverChannelMessageCommon &
  (
    | { readonly alertKind?: 'dispatch'; readonly toneSequence: number }
    | { readonly alertKind: 'mutual_aid_prompt'; readonly toneSequence?: undefined }
  );

interface SendGuard {
  readonly sk: string;
  readonly idempotencyKey: string;
  readonly attributes: Record<string, unknown>;
}

function buildSendGuard(params: DeliverChannelMessageParams, sentAt: number): SendGuard {
  const { dispatchId, memberId, channel } = params;
  const channelUpper = channel.toUpperCase();
  if (params.alertKind === 'mutual_aid_prompt') {
    // Disjoint from the producer's MAPROMPT#{memberId}#PUSH record, which mutualAidPort writes
    // before publishing — sharing it would make this worker duplicate-skip every prompt.
    return {
      sk: `MAPROMPT#${memberId}#${channelUpper}#SEND`,
      idempotencyKey: `${dispatchId}#MUTUALAID#${memberId}#${channelUpper}#SEND`,
      attributes: { entityType: 'MUTUAL_AID_PROMPT_SEND' },
    };
  }
  const { toneSequence } = params;
  return {
    sk: `RECEIPT#${memberId}#${channelUpper}#${toneSequence}`,
    idempotencyKey: `${dispatchId}#${toneSequence}#${memberId}#${channelUpper}`,
    attributes: {
      entityType: 'DELIVERY_RECEIPT',
      channelTier: CHANNEL_TIER[channel],
      toneSequence,
      gsi1pk: `MEMBER#${memberId}`,
      gsi1sk: `RECEIPT#${sentAt}#${dispatchId}`,
    },
  };
}

export async function deliverChannelMessage(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  params: DeliverChannelMessageParams,
): Promise<void> {
  const { deptId, dispatchId, memberId, channel, contactChannels, message, env } = params;
  const isTest = params.isTest === true;
  const correlationId = dispatchId;
  const resolved = resolveChannelTarget(channel, contactChannels);
  if (resolved.skipped) {
    logInfo('alerting.channel.no_target', {
      correlationId,
      memberId,
      channel,
      reason: resolved.reason,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'NoTargetRegistered', channel);
    return;
  }

  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  const sentAt = Math.floor(Date.now() / 1000);
  const { sk, idempotencyKey, attributes } = buildSendGuard(params, sentAt);

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk,
          sk,
          ...attributes,
          dispatchId,
          memberId,
          deptId,
          channel: channel.toUpperCase(),
          sentAt,
          deliveredAt: null,
          openedAt: null,
          failureReason: null,
          idempotencyKey,
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      const retried = await reattemptClaimedFailure(ddb, tableName, pk, sk, sentAt);
      if (!retried) {
        logInfo('alerting.channel.duplicate_skipped', { correlationId, memberId, channel });
        emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped', channel);
        return;
      }
    } else {
      logError('alerting.channel.receipt_write_failed', error, {
        correlationId,
        memberId,
        channel,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'SendFailed', channel);
      throw error;
    }
  }

  try {
    await sendViaHttpProvider(channel, resolved.target, message, env, { isTest });
  } catch (error) {
    logError('alerting.channel.send_failed', error, { correlationId, memberId, channel });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SendFailed', channel);
    await recordClaimedFailure(ddb, tableName, pk, sk, error);
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'Sent', channel);
}

async function reattemptClaimedFailure(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
  sentAt: number,
): Promise<boolean> {
  const existing = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
  const item = existing.Item;
  const claimedButFailed =
    Boolean(item) && item?.failureReason != null && item?.deliveredAt == null;
  if (!claimedButFailed) {
    return false;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression: 'SET sentAt = :sentAt REMOVE failureReason',
      ConditionExpression: 'attribute_exists(idempotencyKey) AND deliveredAt = :nullVal',
      ExpressionAttributeValues: { ':sentAt': sentAt, ':nullVal': null },
    }),
  );
  return true;
}

async function recordClaimedFailure(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
  error: unknown,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        UpdateExpression: 'SET failureReason = :reason',
        ConditionExpression: 'attribute_exists(idempotencyKey)',
        ExpressionAttributeValues: {
          ':reason': error instanceof Error ? error.message : String(error),
        },
      }),
    );
  } catch (updateError) {
    logError('alerting.channel.failure_reason_write_failed', updateError, { pk, sk });
  }
}

export function createChannelWorkerHandler(
  channel: ChannelName,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const { tableName } = readAlertingConfig(process.env);
    const ddb = createDynamoClient(process.env);

    async function processRecord(record: SQSEvent['Records'][number]): Promise<void> {
      let envelope: ChannelEnvelopePayload | MutualAidPromptPayload;
      try {
        envelope =
          parseMutualAidPromptEnvelope(record.body, channel) ??
          parseChannelEnvelope(record.body, channel);
      } catch (error) {
        logError('alerting.channel.malformed_event', error, {
          correlationId: record.messageId,
          channel,
        });
        throw error;
      }

      const deptId = toVerifiedDeptId({ deptId: envelope.deptId });
      let contactChannels: ContactChannelSnapshot[] | undefined;
      try {
        const snapshot = await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'),
              sk: `MEMBER#${envelope.memberId}`,
            },
          }),
        );
        contactChannels = snapshot.Item?.contactChannels as ContactChannelSnapshot[] | undefined;
      } catch (error) {
        logError('alerting.channel.eligibility_read_failed', error, {
          correlationId: envelope.dispatchId,
          memberId: envelope.memberId,
          channel,
        });
        throw error;
      }

      const common = {
        deptId,
        dispatchId: envelope.dispatchId,
        memberId: envelope.memberId,
        channel,
        contactChannels,
        env: process.env,
        isTest: envelope.isTest,
      };
      const incidentText = `${envelope.incidentType} — ${envelope.address}`;
      await deliverChannelMessage(
        ddb,
        tableName,
        'alertKind' in envelope
          ? {
              ...common,
              alertKind: 'mutual_aid_prompt',
              message: `MUTUAL AID REQUESTED — ${incidentText}`,
            }
          : { ...common, toneSequence: envelope.toneSequence, message: incidentText },
      );
    }

    const results = await Promise.allSettled(event.Records.map(processRecord));
    const batchItemFailures = results
      .map((result, index) =>
        result.status === 'rejected'
          ? { itemIdentifier: event.Records[index]?.messageId ?? '' }
          : null,
      )
      .filter((failure): failure is { itemIdentifier: string } => failure !== null);

    return { batchItemFailures };
  };
}
