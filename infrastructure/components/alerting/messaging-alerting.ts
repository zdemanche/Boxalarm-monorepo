import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";

export type AlertingChannel = "push" | "sms" | "voice";
export const ALERTING_CHANNELS: readonly AlertingChannel[] = ["push", "sms", "voice"];

/**
 * Channel-worker Lambda timeout (seconds): a secret fetch plus one vendor HTTPS call.
 * Shared by MessagingAlerting (queue visibility = 2x this) and ChannelWorkers (the
 * Lambda's own timeout) so the two cannot drift apart.
 */
export const DEFAULT_WORKER_TIMEOUT_SECONDS = 15;

/**
 * Memory (MB) for the paging-path Lambdas: fan-out, the channel workers, escalation and the
 * tone evaluator. Lambda CPU scales with memory, so the 128 MB default would slow every page.
 */
export const ALERT_PATH_MEMORY_MB = 512;

export interface MessagingAlertingArgs {
  env: string;
  /** Worker Lambda timeout per channel (seconds); queue visibility is set to 2x this. */
  workerTimeoutSeconds?: number;
}

export interface ChannelQueue {
  readonly queue: aws.sqs.Queue;
  readonly dlq: aws.sqs.Queue;
}

/**
 * The alerting messaging plane (E1-S2/S3-INFRA): SNS FIFO topic + one SQS FIFO queue
 * per channel, each with its own DLQ. Shares no construct with the LOB `messaging.ts`
 * (none exists yet). Routing/dedup keys on `channel` only — never `channelTier` or
 * `toneSequence` (boxalarm-docs#12).
 */
export class MessagingAlerting extends pulumi.ComponentResource {
  public readonly topic: aws.sns.Topic;
  public readonly channelQueues: Record<AlertingChannel, ChannelQueue>;

  constructor(name: string, args: MessagingAlertingArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("MessagingAlerting", args.env);
    super("boxalarm:alerting:MessagingAlerting", name, {}, opts);
    const { env } = args;
    const workerTimeoutSeconds = args.workerTimeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS;
    // FIFO head-of-line trade-off: keep this at 2x the worker timeout, no tighter.
    //
    // Every publisher sets MessageGroupId: dispatchId: fanout/handler.ts,
    // escalation/snsClient.ts, escalation/toneEvaluatorHandler.ts and
    // escalation/mutualAidPort.ts. So every member of one dispatch on one channel
    // shares a FIFO group. One member stuck behind a slow or failing vendor call
    // holds up every later member in that group until it is deleted or
    // dead-lettered. Worst case that is maxReceiveCount (3) x visibility, about 90s
    // at the default 15s worker timeout. The per-queue oldest-message alarm (120s,
    // alarms.ts) sits just above that bound.
    //
    // Fix considered and deferred: scoping MessageGroupId to `{dispatchId}#{memberId}`
    // would remove the block. Nothing here needs cross-member ordering within a
    // dispatch: each receipt is keyed per {dispatchId}#{toneSequence}#{memberId}#{channel}
    // and workers handle members independently. That change lives in the backend
    // publishers and alters FIFO dedup/ordering semantics on the alert path (see #12),
    // so it is a tracked backend follow-up, not an infra edit.
    //
    // Going below 2x to shrink the window from the infra side was rejected. It narrows
    // the margin between the worker's Lambda timeout and message re-visibility, so an
    // in-flight vendor send could be redelivered and sent twice. A duplicate
    // SMS/voice/push page is worse than a slower one. The 2x formula is pinned by
    // test/alerting/timeouts.test.ts.
    const visibilityTimeoutSeconds = workerTimeoutSeconds * 2;

    this.topic = new aws.sns.Topic(
      `${name}-topic`,
      {
        name: `boxalarm-${env}-alerting-topic.fifo`,
        fifoTopic: true,
        // The publisher (fan-out / escalation) sets MessageDeduplicationId explicitly
        // from the {dispatchId}#{toneSequence}#{memberId}#{channel} key — content-based
        // dedup would hash the envelope body instead and silently diverge from it.
        contentBasedDeduplication: false,
      },
      { parent: this },
    );

    this.channelQueues = Object.fromEntries(
      ALERTING_CHANNELS.map((channel) => {
        const dlq = new aws.sqs.Queue(
          `${name}-${channel}-dlq`,
          {
            name: `boxalarm-${env}-alerting-${channel}-dlq.fifo`,
            fifoQueue: true,
            // 14 days (the SQS maximum), like the fan-out on-failure queue. A FIFO DLQ keeps
            // the original enqueue timestamp, so at the 4-day default the evidence of a missed
            // page could expire over a long weekend before anyone inspects it.
            messageRetentionSeconds: 1_209_600,
          },
          { parent: this },
        );

        const queue = new aws.sqs.Queue(
          `${name}-${channel}-queue`,
          {
            name: `boxalarm-${env}-alerting-${channel}-queue.fifo`,
            fifoQueue: true,
            visibilityTimeoutSeconds,
            redrivePolicy: dlq.arn.apply((arn) =>
              JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 3 }),
            ),
          },
          { parent: this },
        );

        new aws.sqs.QueuePolicy(
          `${name}-${channel}-queue-policy`,
          {
            queueUrl: queue.url,
            policy: pulumi.all([queue.arn, this.topic.arn]).apply(([queueArn, topicArn]) =>
              JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "AllowAlertingTopicOnly",
                    Effect: "Allow",
                    Principal: { Service: "sns.amazonaws.com" },
                    Action: "sqs:SendMessage",
                    Resource: queueArn,
                    Condition: { ArnEquals: { "aws:SourceArn": topicArn } },
                  },
                ],
              }),
            ),
          },
          { parent: this },
        );

        new aws.sns.TopicSubscription(
          `${name}-${channel}-subscription`,
          {
            topic: this.topic.arn,
            protocol: "sqs",
            endpoint: queue.arn,
            rawMessageDelivery: true,
            // channel only — never channelTier/toneSequence (boxalarm-docs#12).
            filterPolicy: JSON.stringify({ channel: [channel] }),
          },
          { parent: this },
        );

        return [channel, { queue, dlq }];
      }),
    ) as Record<AlertingChannel, ChannelQueue>;

    this.registerOutputs({ topic: this.topic });
  }
}
