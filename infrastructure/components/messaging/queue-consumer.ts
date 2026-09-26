import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface QueueConsumerArgs {
  env: string;
  busName: pulumi.Input<string>;
  busArn: pulumi.Input<string>;
  ruleName: string;
  eventPattern: string;
  queueName: string;
  lambda: aws.lambda.Function;
  lambdaRole: aws.iam.Role;
  maxReceiveCount?: number;
  batchSize?: number;
  /**
   * Caps how many concurrent Lambda executions this queue's event source mapping can
   * drive. Left unset, SQS event source mappings have no concurrency ceiling of their
   * own — a burst on this queue can consume account-level concurrency that
   * alerting-service's Lambdas share from the same pool (alerting-service is not
   * VPC-attached and has no reserved concurrency of its own to insulate it). Defaults
   * to a small cap suited to LOB-plane traffic volumes; override for a consumer that
   * legitimately needs more.
   */
  maximumConcurrency?: number;
  /**
   * Opt in only for a handler that returns an SQSBatchResponse (`batchItemFailures`).
   * With it set, a handler that returns nothing (or throws for the batch) is treated
   * as all-succeeded / all-failed respectively, so leave it off for handlers that
   * still signal failure by throwing — they'd otherwise have their failures deleted.
   */
  reportBatchItemFailures?: boolean;
}

/**
 * Reusable "Lambda consumes an EventBridge rule via SQS" wiring: DLQ, main
 * queue with redrive, an EventBridge rule + target on the given bus, an SQS
 * event source mapping, and the IAM the consumer Lambda needs to drain it.
 */
export class QueueConsumer extends pulumi.ComponentResource {
  public readonly queue: aws.sqs.Queue;
  public readonly dlq: aws.sqs.Queue;
  public readonly rule: aws.cloudwatch.EventRule;
  public readonly target: aws.cloudwatch.EventTarget;
  public readonly eventSourceMapping: aws.lambda.EventSourceMapping;
  public readonly dlqDepthAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: QueueConsumerArgs, opts?: pulumi.ComponentResourceOptions) {
    super("boxalarm:messaging:QueueConsumer", name, {}, opts);
    const maxReceiveCount = args.maxReceiveCount ?? 5;

    this.dlq = new aws.sqs.Queue(
      `${name}-dlq`,
      { name: `${args.queueName}-dlq` },
      { parent: this },
    );

    this.queue = new aws.sqs.Queue(
      `${name}-queue`,
      {
        name: args.queueName,
        redrivePolicy: this.dlq.arn.apply((arn) =>
          JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount }),
        ),
      },
      { parent: this },
    );

    const queuePolicy = new aws.sqs.QueuePolicy(
      `${name}-queue-policy`,
      {
        queueUrl: this.queue.id,
        policy: pulumi.all([this.queue.arn, args.busArn]).apply(([queueArn, busArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowEventBridgeSend",
                Effect: "Allow",
                Principal: { Service: "events.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: queueArn,
                Condition: { ArnEquals: { "aws:SourceArn": busArn } },
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.rule = new aws.cloudwatch.EventRule(
      `${name}-rule`,
      { name: args.ruleName, eventBusName: args.busName, eventPattern: args.eventPattern },
      { parent: this },
    );

    this.target = new aws.cloudwatch.EventTarget(
      `${name}-target`,
      { rule: this.rule.name, eventBusName: args.busName, arn: this.queue.arn },
      { parent: this, dependsOn: [queuePolicy] },
    );

    this.eventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-esm`,
      {
        eventSourceArn: this.queue.arn,
        functionName: args.lambda.name,
        batchSize: args.batchSize ?? 10,
        scalingConfig: { maximumConcurrency: args.maximumConcurrency ?? 5 },
        ...(args.reportBatchItemFailures
          ? { functionResponseTypes: ["ReportBatchItemFailures"] }
          : {}),
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-consume-policy`,
      {
        role: args.lambdaRole.id,
        policy: this.queue.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ConsumeQueue",
                Effect: "Allow",
                Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
                Resource: arn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.dlqDepthAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-dlq-depth-alarm`,
      {
        name: `${args.queueName}-dlq-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.dlq.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.registerOutputs({ queue: this.queue, dlq: this.dlq, rule: this.rule });
  }
}
