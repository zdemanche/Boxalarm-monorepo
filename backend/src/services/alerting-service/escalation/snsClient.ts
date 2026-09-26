import { createHash, randomUUID } from 'node:crypto';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import AWSXRay from 'aws-xray-sdk-core';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildChannelPagePayload, type DispatchAlertText } from '../channels/channelEnvelope.js';
import { logError } from '../dispatches/logger.js';

export interface AlertingTopicConfig {
  readonly topicArn: string;
}

export function readAlertingTopicConfig(env: NodeJS.ProcessEnv): AlertingTopicConfig {
  const topicArn = env.ALERTING_TOPIC_ARN;
  if (!topicArn) {
    throw new Error('ALERTING_TOPIC_ARN is required and was not set');
  }
  return { topicArn };
}

let cachedSnsClient: SNSClient | undefined;

export function getSnsClient(client?: SNSClient): SNSClient {
  cachedSnsClient ??= client ?? AWSXRay.captureAWSv3Client(new SNSClient({}));
  return cachedSnsClient;
}

export interface PublishEscalationTriggeredInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly toneSequence: number;
  /** From the dispatch's METADATA item — the voice worker speaks incidentType/address. */
  readonly dispatch: DispatchAlertText;
}

export function buildEscalationDeduplicationId(
  dispatchId: string,
  toneSequence: number,
  memberId: string,
): string {
  return createHash('sha256')
    .update(`${dispatchId}#${toneSequence}#${memberId}#voice`)
    .digest('hex');
}

export async function publishEscalationTriggered(
  sns: SNSClient,
  topicArn: string,
  input: PublishEscalationTriggeredInput,
): Promise<void> {
  const { deptId, dispatchId, memberId, toneSequence, dispatch } = input;
  const envelope = {
    eventId: randomUUID(),
    eventTime: new Date().toISOString(),
    eventType: 'alerting.escalation.triggered',
    source: 'escalation-scheduler',
    correlationId: dispatchId,
    schemaVersion: '1.0',
    payload: buildChannelPagePayload({
      deptId,
      dispatchId,
      memberId,
      channel: 'voice',
      channelTier: 'escalation',
      toneSequence,
      dispatch,
      reason: 'no_ack_at_tier',
    }),
  };

  try {
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(envelope),
        MessageGroupId: dispatchId,
        MessageDeduplicationId: buildEscalationDeduplicationId(dispatchId, toneSequence, memberId),
        MessageAttributes: {
          channel: { DataType: 'String', StringValue: 'voice' },
          channelTier: { DataType: 'String', StringValue: 'escalation' },
          toneSequence: { DataType: 'Number', StringValue: String(toneSequence) },
        },
      }),
    );
  } catch (error) {
    logError('alerting.escalation.publish_failed', error, {
      deptId,
      dispatchId,
      memberId,
      toneSequence,
    });
    throw error;
  }
}
