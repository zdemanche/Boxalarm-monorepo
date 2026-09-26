import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";

export interface AlertingOutboxDrainArgs {
  env: string;
  alertingTableName: pulumi.Input<string>;
  alertingTableArn: pulumi.Input<string>;
  alertingStreamArn: pulumi.Input<string>;
  alertingCmkArn: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  busArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn: pulumi.Input<string>;
  /** AlertingAlarms' page topic: a stalled bridge silently drops incident dispatch data. */
  pageTopicArn: pulumi.Input<string>;
}

/** Must match the backend drain's metricNamespace (alerting-service/outboxDrainHandler.ts). */
export const ALERTING_BRIDGE_METRIC_NAMESPACE = "Boxalarm/alerting-bridge";

/**
 * The one-way alerting → LOB platform-bus bridge (PR #324 follow-up). Deploys
 * backend/src/services/alerting-service/outboxDrainHandler.ts, which republishes the
 * allow-listed alerting OUTBOX_ENTRY rows (dispatch.alert.received,
 * alerting.response.confirmed, alerting.tone.escalated, alerting.mutual_aid.triggered)
 * onto boxalarm-{env}-platform-bus, where incident-service's consumers already have
 * rules. Without this component those rules never see an event.
 *
 * It is the second reader on the alerting-table stream, after fan-out. DynamoDB Streams
 * guidance is at most two readers per shard, so later bridged event types must reuse
 * this drain and not add a third reader.
 */
export class AlertingOutboxDrain extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly onFailureQueue: aws.sqs.Queue;
  public readonly eventSourceMapping: aws.lambda.EventSourceMapping;
  public readonly onFailureAlarm: aws.cloudwatch.MetricAlarm;
  public readonly publishFailedAlarm: aws.cloudwatch.MetricAlarm;
  public readonly eventTypeRejectedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: AlertingOutboxDrainArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertingOutboxDrain", args.env);
    super("boxalarm:alerting:AlertingOutboxDrain", name, {}, opts);
    const { env } = args;
    const region = aws.getRegionOutput({}, { parent: this });

    this.onFailureQueue = new aws.sqs.Queue(
      `${name}-onfailure`,
      {
        name: `boxalarm-${env}-alerting-outbox-drain-onfailure`,
        messageRetentionSeconds: 1_209_600,
        sqsManagedSseEnabled: true,
      },
      { parent: this },
    );

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-outbox-drain`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "outbox-drain"),
        logGroup: args.logGroup,
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          PLATFORM_EVENT_BUS_NAME: args.busName,
        },
        // Stream read lives in the role policy itself (not a sibling RolePolicy) so it
        // exists before the Lambda, and therefore before the event source mapping.
        additionalPolicyStatements: pulumi
          .all([
            args.busArn,
            args.alertingTableArn,
            args.alertingStreamArn,
            args.alertingCmkArn,
            this.onFailureQueue.arn,
            region.name,
          ])
          .apply(([busArn, tableArn, streamArn, cmkArn, onFailureArn, regionName]) => [
            {
              Sid: "PublishToPlatformBus",
              Effect: "Allow" as const,
              Action: ["events:PutEvents"],
              Resource: busArn,
            },
            {
              // The shared drain SETs sentAt after each successful PutEvents.
              Sid: "MarkAlertingOutboxEntrySent",
              Effect: "Allow" as const,
              Action: ["dynamodb:UpdateItem"],
              Resource: tableArn,
            },
            {
              Sid: "ReadAlertingTableStream",
              Effect: "Allow" as const,
              Action: [
                "dynamodb:GetRecords",
                "dynamodb:GetShardIterator",
                "dynamodb:DescribeStream",
                "dynamodb:ListStreams",
              ],
              Resource: streamArn,
            },
            {
              // The alerting table is encrypted with its own CMK, and the key policy
              // delegates to IAM. This grant only works through DynamoDB.
              Sid: "DecryptAlertingTableViaDynamoDb",
              Effect: "Allow" as const,
              Action: ["kms:Decrypt"],
              Resource: cmkArn,
              Condition: {
                StringEquals: { "kms:ViaService": [`dynamodb.${regionName}.amazonaws.com`] },
              },
            },
            {
              // Stream on-failure destinations are written with the function's role.
              Sid: "SendToOnFailureDestination",
              Effect: "Allow" as const,
              Action: ["sqs:SendMessage"],
              Resource: onFailureArn,
            },
          ]),
        // Its own reservation, so a bridge backlog can never take concurrency from the
        // alerting Lambdas on the page path, and vice versa.
        reservedConcurrentExecutions: 5,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    this.eventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-esm`,
      {
        eventSourceArn: args.alertingStreamArn,
        functionName: this.lambda.function.name,
        startingPosition: "LATEST",
        batchSize: 10,
        // The handler returns { batchItemFailures } on a PutEvents failure. Without
        // ReportBatchItemFailures Lambda treats that return as success and advances
        // past the event, so dispatch.alert.received would be lost with no error.
        functionResponseTypes: ["ReportBatchItemFailures"],
        bisectBatchOnFunctionError: true,
        // A department's outbox rows share one partition, so they share one shard. An
        // unbounded retry on a poison entry would stall every bridge event for that
        // department for the whole 24h stream retention.
        maximumRetryAttempts: 5,
        maximumRecordAgeInSeconds: 3600,
        // Only new outbox rows invoke the drain. Fan-out's DELIVERY_RECEIPT writes, the
        // drain's own sentAt MODIFYs, and TTL REMOVEs never do.
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                eventName: ["INSERT"],
                dynamodb: { NewImage: { entityType: { S: ["OUTBOX_ENTRY"] } } },
              }),
            },
          ],
        },
        destinationConfig: { onFailure: { destinationArn: this.onFailureQueue.arn } },
      },
      { parent: this },
    );

    this.onFailureAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-onfailure-alarm`,
      {
        name: `boxalarm-${env}-alerting-outbox-drain-onfailure-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.onFailureQueue.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    this.publishFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-publish-failed-alarm`,
      {
        name: `boxalarm-${env}-alerting-bridge-publish-failed`,
        namespace: ALERTING_BRIDGE_METRIC_NAMESPACE,
        metricName: "PublishFailed",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    this.eventTypeRejectedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-event-type-rejected-alarm`,
      {
        name: `boxalarm-${env}-alerting-bridge-event-type-rejected`,
        namespace: ALERTING_BRIDGE_METRIC_NAMESPACE,
        metricName: "EventTypeRejected",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    this.registerOutputs({
      lambda: this.lambda,
      onFailureQueue: this.onFailureQueue,
      eventSourceMapping: this.eventSourceMapping,
    });
  }
}
