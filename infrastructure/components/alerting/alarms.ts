import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";
import { ALERTING_CHANNELS, AlertingChannel, ChannelQueue } from "./messaging-alerting";

const NON_PROD_ENVS = new Set(["dev", "qa", "staging"]);

export interface AlertingAlarmsArgs {
  env: string;
  channelQueues: Record<AlertingChannel, ChannelQueue>;
  fanOutFunctionName: pulumi.Input<string>;
  /** Fan-out stream ESM on-failure destination — a record here is a dispatch nobody was paged for. */
  fanOutOnFailureQueue: aws.sqs.Queue;
  escalationFunctionName: pulumi.Input<string>;
  toneEvaluatorFunctionName: pulumi.Input<string>;
  memberUpdatedDlq: aws.sqs.Queue;
  memberUpdatedFunctionName: pulumi.Input<string>;
}

/** Stack config key for the alerting-page email subscription. */
export const ALERTING_PAGE_EMAIL_CONFIG_KEY = "alertingPageEmail";

/**
 * Alerting-plane paging (E1-S11-INFRA): a dedicated standard SNS topic
 * (`alerting-page`, distinct from the FIFO delivery topic) that every alerting alarm
 * pages through, an alarm on every alert-path failure mode, and a per-channel
 * fault-injection SSM switch present in dev/qa/staging only (never prod).
 *
 * The page subscription is config-driven (`boxalarm-infra:alertingPageEmail`). Who carries
 * the pager is still open (#5), so this is a mechanism, not the final on-call route. It is
 * REQUIRED in prod — a prod stack whose alerting alarms page nobody fails preview — and
 * warned about at preview/up time in every other stack.
 */
export class AlertingAlarms extends pulumi.ComponentResource {
  public readonly pageTopic: aws.sns.Topic;
  public readonly pageSubscription?: aws.sns.TopicSubscription;
  public readonly faultInjectionParameters: Partial<Record<AlertingChannel, aws.ssm.Parameter>>;

  constructor(name: string, args: AlertingAlarmsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertingAlarms", args.env);
    super("boxalarm:alerting:AlertingAlarms", name, {}, opts);
    const { env } = args;

    this.pageTopic = new aws.sns.Topic(
      `${name}-page-topic`,
      { name: `boxalarm-${env}-alerting-page` },
      { parent: this },
    );

    const pageEmail = new pulumi.Config("boxalarm-infra").get(ALERTING_PAGE_EMAIL_CONFIG_KEY);
    if (pageEmail) {
      this.pageSubscription = new aws.sns.TopicSubscription(
        `${name}-page-email-subscription`,
        { topic: this.pageTopic.arn, protocol: "email", endpoint: pageEmail },
        { parent: this },
      );
    } else if (env === "prod") {
      throw new Error(
        `AlertingAlarms: boxalarm-infra:${ALERTING_PAGE_EMAIL_CONFIG_KEY} is required in prod — ` +
          `without it boxalarm-prod-alerting-page has no subscription and every alerting ` +
          `alarm pages nobody. Set it with \`pulumi config set ${ALERTING_PAGE_EMAIL_CONFIG_KEY} ` +
          `<address> --stack prod\`.`,
      );
    } else {
      pulumi.log.warn(
        `AlertingAlarms: boxalarm-infra:${ALERTING_PAGE_EMAIL_CONFIG_KEY} is not set — ` +
          `boxalarm-${env}-alerting-page has no subscription, so every alerting alarm fires ` +
          `into the void. Set it, or confirm on-call routing is subscribed out-of-band.`,
        this,
      );
    }

    const pageAlarm = (
      key: string,
      alarm: Omit<aws.cloudwatch.MetricAlarmArgs, "alarmActions" | "treatMissingData">,
    ): aws.cloudwatch.MetricAlarm =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-${key}`,
        { ...alarm, treatMissingData: "notBreaching", alarmActions: [this.pageTopic.arn] },
        { parent: this },
      );

    const lambdaAlarm = (
      key: string,
      functionName: pulumi.Input<string>,
      metricName: "Errors" | "Throttles",
      alarmName: string,
    ) =>
      pageAlarm(key, {
        name: alarmName,
        namespace: "AWS/Lambda",
        metricName,
        dimensions: { FunctionName: functionName },
        statistic: "Sum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 60,
        evaluationPeriods: 1,
      });

    // Fan-out: Errors, a stuck stream (IteratorAge), and any record that exhausted its
    // retries into the on-failure queue — each is a dispatch that may have paged nobody.
    lambdaAlarm(
      "fan-out-errors-alarm",
      args.fanOutFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-fan-out-errors`,
    );
    pageAlarm("fan-out-iterator-age-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-iterator-age`,
      namespace: "AWS/Lambda",
      metricName: "IteratorAge",
      dimensions: { FunctionName: args.fanOutFunctionName },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      // 60s: a DISPATCH_ALERT unprocessed for a minute is already a missed tone-out.
      threshold: 60_000,
      period: 60,
      evaluationPeriods: 1,
    });
    pageAlarm("fan-out-onfailure-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-onfailure-not-empty`,
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: args.fanOutOnFailureQueue.name },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    // Escalation and tone-evaluator are invoked async by EventBridge Scheduler with no
    // onFailure destination: a throw is retried twice and then dropped with no record.
    lambdaAlarm(
      "escalation-errors-alarm",
      args.escalationFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-escalation-errors`,
    );
    lambdaAlarm(
      "escalation-throttles-alarm",
      args.escalationFunctionName,
      "Throttles",
      `boxalarm-${env}-alerting-escalation-throttles`,
    );
    lambdaAlarm(
      "tone-evaluator-errors-alarm",
      args.toneEvaluatorFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-tone-evaluator-errors`,
    );
    lambdaAlarm(
      "tone-evaluator-throttles-alarm",
      args.toneEvaluatorFunctionName,
      "Throttles",
      `boxalarm-${env}-alerting-tone-evaluator-throttles`,
    );

    // A lost personnel.member.updated event means a member silently stops getting push.
    // (Replaces push-tokens' action-less member-updated-dlq-depth alarm; new physical name
    // so replacing it cannot delete the new alarm by name.)
    pageAlarm("member-updated-dlq-alarm", {
      name: `boxalarm-${env}-alerting-member-updated-dlq-not-empty`,
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: args.memberUpdatedDlq.name },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    // The consumer throws on a bad record or a DynamoDB failure; the DLQ alarm only fires
    // after 5 receives, so page on the errors themselves too.
    lambdaAlarm(
      "member-updated-errors-alarm",
      args.memberUpdatedFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-member-updated-consumer-errors`,
    );

    for (const channel of ALERTING_CHANNELS) {
      const dlq = args.channelQueues[channel].dlq;

      // A worker that is consuming but stuck (hung vendor call) before anything reaches
      // the DLQ. A healthy queue never holds a message this long.
      pageAlarm(`${channel}-oldest-message-alarm`, {
        name: `boxalarm-${env}-alerting-${channel}-oldest-message-age`,
        namespace: "AWS/SQS",
        metricName: "ApproximateAgeOfOldestMessage",
        dimensions: { QueueName: args.channelQueues[channel].queue.name },
        statistic: "Maximum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 120,
        period: 60,
        evaluationPeriods: 2,
      });

      new aws.cloudwatch.MetricAlarm(
        `${name}-${channel}-dlq-alarm`,
        {
          name: `boxalarm-${env}-alerting-${channel}-dlq-not-empty`,
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensions: { QueueName: dlq.name },
          statistic: "Maximum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 0,
          period: 60,
          evaluationPeriods: 1,
          treatMissingData: "notBreaching",
          alarmActions: [this.pageTopic.arn],
        },
        { parent: this },
      );

      new aws.cloudwatch.MetricAlarm(
        `${name}-${channel}-delivery-failure-alarm`,
        {
          name: `boxalarm-${env}-alerting-${channel}-delivery-failure-rate`,
          namespace: `Boxalarm/AlertingChannel`,
          metricName: "SendFailed",
          // Cross-seam contract: deliverChannelMessage.ts emits
          // emitOutcomeMetric("Boxalarm/AlertingChannel", "SendFailed", channel), and
          // @boxalarm/metrics publishes that reason under the `Reason` dimension (dimension
          // sets [] and ["Reason"]). There is no `channel` dimension — alarming on one
          // matched no series, so this alarm could never fire.
          dimensions: { Reason: channel },
          statistic: "Sum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 0,
          period: 60,
          evaluationPeriods: 1,
          treatMissingData: "notBreaching",
          alarmActions: [this.pageTopic.arn],
        },
        { parent: this },
      );
    }

    this.faultInjectionParameters = NON_PROD_ENVS.has(env)
      ? Object.fromEntries(
          ALERTING_CHANNELS.map((channel) => [
            channel,
            new aws.ssm.Parameter(
              `${name}-${channel}-fault-injection`,
              {
                name: `/boxalarm/${env}/alerting/${channel}/fault-injection`,
                type: "String",
                value: "off",
                description: `Non-prod fault-injection switch for the ${channel} worker`,
              },
              { parent: this },
            ),
          ]),
        )
      : {};

    this.registerOutputs({ pageTopic: this.pageTopic });
  }
}
