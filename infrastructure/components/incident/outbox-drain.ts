import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface IncidentOutboxDrainArgs {
  env: string;
  incidentTableName: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
  incidentTableStreamArn: pulumi.Input<string>;
  incidentCmkArn: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  busArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/**
 * incident-table outbox → platform-bus publisher. The platform OutboxPublisher only
 * reads the platform table's stream, so without this every OUTBOX_ENTRY
 * incident-service writes (incident.created, neris.incident.submitted,
 * neris.submission.failed, …) stays in the table and never reaches the bus.
 *
 * Same shape as OutboxPublisher: a DynamoDB Streams mapping filtered at the ESM
 * to INSERTs of `entityType = OUTBOX_ENTRY`, bounded retries, batch bisection,
 * ReportBatchItemFailures (the shared drain handler returns batchItemFailures),
 * and an alarmed on-failure queue. The table is CMK-encrypted, so the role also
 * needs the CMK to read stream records and to write the sentAt mark.
 */
export class IncidentOutboxDrain extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly onFailureQueue: aws.sqs.Queue;
  public readonly eventSourceMapping: aws.lambda.EventSourceMapping;
  public readonly onFailureAlarm: aws.cloudwatch.MetricAlarm;
  public readonly streamReadPolicy: aws.iam.RolePolicy;
  public readonly onFailureSendPolicy: aws.iam.RolePolicy;

  constructor(name: string, args: IncidentOutboxDrainArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("IncidentOutboxDrain", args.env);
    super("boxalarm:incident:IncidentOutboxDrain", name, {}, opts);
    const { env } = args;

    this.onFailureQueue = new aws.sqs.Queue(
      `${name}-onfailure`,
      { name: `boxalarm-${env}-incident-outbox-drain-onfailure` },
      { parent: this },
    );

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-outbox-drain`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "outbox-drain"),
        logGroup: args.logGroup,
        environment: {
          // @boxalarm/outbox's drain handler reads the table to mark sentAt from
          // PLATFORM_TABLE_NAME whatever table it drains — here, the incident table.
          PLATFORM_TABLE_NAME: args.incidentTableName,
          PLATFORM_EVENT_BUS_NAME: args.busName,
          INCIDENT_TABLE_NAME: args.incidentTableName,
        },
        additionalPolicyStatements: pulumi
          .all([args.busArn, args.incidentTableArn, args.incidentCmkArn])
          .apply(([busArn, tableArn, cmkArn]) => [
            {
              Sid: "PublishToPlatformBus" as const,
              Effect: "Allow" as const,
              Action: ["events:PutEvents"],
              Resource: busArn,
            },
            {
              // SET sentAt after each successful PutEvents. Without it every
              // stream retry re-publishes the batch (see OutboxPublisher).
              Sid: "MarkOutboxEntrySent" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:UpdateItem"],
              Resource: tableArn,
            },
            {
              Sid: "IncidentCmkAccess" as const,
              Effect: "Allow" as const,
              Action: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
              Resource: cmkArn,
            },
          ]),
      },
      { parent: this },
    );

    // Stream-read grant must exist before the mapping is created, or AWS rejects
    // the EventSourceMapping for lack of permission on the stream.
    this.streamReadPolicy = new aws.iam.RolePolicy(
      `${name}-stream-read-policy`,
      {
        role: this.lambda.role.id,
        policy: pulumi.output(args.incidentTableStreamArn).apply((streamArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ReadIncidentTableStream",
                Effect: "Allow",
                Action: [
                  "dynamodb:GetRecords",
                  "dynamodb:GetShardIterator",
                  "dynamodb:DescribeStream",
                  "dynamodb:ListStreams",
                ],
                Resource: streamArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.eventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-esm`,
      {
        eventSourceArn: args.incidentTableStreamArn,
        functionName: this.lambda.function.name,
        startingPosition: "LATEST",
        batchSize: 10,
        bisectBatchOnFunctionError: true,
        functionResponseTypes: ["ReportBatchItemFailures"],
        // Bounded — the stream default is unbounded retries/record age, which
        // re-publishes already-sent events for up to the stream's 24h retention.
        maximumRetryAttempts: 5,
        maximumRecordAgeInSeconds: 3600,
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
      { parent: this, dependsOn: [this.streamReadPolicy, this.lambda.rolePolicy] },
    );

    // The on-failure destination is written by the Lambda service using the
    // function's execution role.
    this.onFailureSendPolicy = new aws.iam.RolePolicy(
      `${name}-onfailure-send-policy`,
      {
        role: this.lambda.role.id,
        policy: this.onFailureQueue.arn.apply((queueArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "SendToOnFailureQueue",
                Effect: "Allow",
                Action: ["sqs:SendMessage"],
                Resource: queueArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.onFailureAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-onfailure-alarm`,
      {
        name: `boxalarm-${env}-incident-outbox-drain-onfailure-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.onFailureQueue.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda, onFailureQueue: this.onFailureQueue });
  }
}
