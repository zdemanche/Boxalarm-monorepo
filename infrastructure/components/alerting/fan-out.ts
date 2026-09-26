import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { Escalation } from "./escalation";
import { grantAlertingCmk } from "./alerting-cmk";
import { ALERT_PATH_MEMORY_MB } from "./messaging-alerting";

export interface FanOutArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  alertingStreamArn: pulumi.Input<string>;
  alertingTopicArn: pulumi.Input<string>;
  escalation: Escalation;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Fan-out Lambda (E1-S2-INFRA): triggered by the alerting-table DynamoDB Stream,
 * filtered to INSERT of DISPATCH_ALERT items, publishes one SNS FIFO message per
 * {member, channel} to the push/sms queues in parallel, and (E1-S3-INFRA) creates the
 * per-member voice escalation schedule and the department tone-2/3 evaluator timers.
 */
export class FanOut extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly eventSourceMapping: aws.lambda.EventSourceMapping;
  /** Stream records that exhausted their retries land here instead of vanishing. */
  public readonly onFailureQueue: aws.sqs.Queue;

  constructor(name: string, args: FanOutArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("FanOut", args.env);
    super("boxalarm:alerting:FanOut", name, {}, opts);
    const { env } = args;

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-fan-out`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "fan-out"),
        logGroup: args.logGroup,
        // The stream path schedules each member's tone-1 voice escalation and the
        // department tone-2/3 ladder (fanout/fanOut.ts scheduleRealtimeFanOutEscalation);
        // scheduleEscalation.ts / toneLadder.ts throw when these are unset, which fails
        // the whole dispatch record.
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          ALERTING_TOPIC_ARN: args.alertingTopicArn,
          ESCALATION_HANDLER_ARN: args.escalation.lambda.function.arn,
          ESCALATION_SCHEDULER_ROLE_ARN: args.escalation.schedulerRole.arn,
          TONE_EVALUATOR_HANDLER_ARN: args.escalation.toneEvaluatorLambda.function.arn,
          ESCALATION_SCHEDULE_GROUP_NAME: args.escalation.scheduleGroupName,
        },
        additionalPolicyStatements: pulumi
          .all([args.escalation.scheduleResourcePattern, args.alertingStreamArn])
          .apply(([pattern, streamArn]) => [
            {
              // The stream event source mapping reads as this role.
              Sid: "ReadAlertingTableStream",
              Effect: "Allow" as const,
              Action: [
                "dynamodb:DescribeStream",
                "dynamodb:GetRecords",
                "dynamodb:GetShardIterator",
              ],
              Resource: streamArn,
            },
            {
              // ListStreams has no resource-level scoping — AWS requires "*".
              Sid: "ListStreams",
              Effect: "Allow" as const,
              Action: ["dynamodb:ListStreams"],
              Resource: "*",
            },
            {
              Sid: "AlertingTableReadWrite",
              Effect: "Allow" as const,
              Action: [
                "dynamodb:Query",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:TransactWriteItems",
              ],
              Resource: args.alertingTableArn as string,
            },
            {
              Sid: "AlertingTopicPublish",
              Effect: "Allow" as const,
              Action: ["sns:Publish"],
              Resource: args.alertingTopicArn as string,
            },
            {
              Sid: "CreateEscalationSchedulesOnly",
              Effect: "Allow" as const,
              Action: ["scheduler:CreateSchedule"],
              Resource: pattern,
            },
          ]),
        reservedConcurrentExecutions: 10,
        // Eligibility query, concurrent per-member receipt write + SNS publish, then
        // serial per-member escalation scheduling — far beyond the 3s default.
        timeout: 30,
        memorySize: ALERT_PATH_MEMORY_MB,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-pass-scheduler-role`,
      {
        role: this.lambda.role.id,
        policy: args.escalation.schedulerRole.arn.apply((roleArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "PassSchedulerRoleOnly",
                Effect: "Allow",
                Action: "iam:PassRole",
                Resource: roleArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.onFailureQueue = new aws.sqs.Queue(
      `${name}-onfailure-queue`,
      {
        name: `boxalarm-${env}-alerting-fan-out-onfailure`,
        messageRetentionSeconds: 1209600,
      },
      { parent: this },
    );

    // The ESM (running as this role) sends the failed-batch record to the on-failure
    // destination; without SendMessage the destination write fails too.
    const onFailurePolicy = new aws.iam.RolePolicy(
      `${name}-onfailure-send`,
      {
        role: this.lambda.role.id,
        policy: this.onFailureQueue.arn.apply((queueArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "SendToOwnOnFailureQueue",
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

    // Stream records of a CMK-encrypted table are decrypted with the same key.
    const cmkPolicies = grantAlertingCmk(name, { fanOut: this.lambda.role }, args.alertingCmkArn, {
      parent: this,
    });

    this.eventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-event-source`,
      {
        eventSourceArn: args.alertingStreamArn,
        functionName: this.lambda.function.name,
        startingPosition: "LATEST",
        // fanout/handler.ts never throws: a malformed record or a failed dispatch is
        // *returned* as { batchItemFailures }. Without this, Lambda treats that return as
        // full success and checkpoints past the failed dispatch — nobody is paged.
        functionResponseTypes: ["ReportBatchItemFailures"],
        // Split a poison-pill record away from the healthy dispatches in its batch.
        bisectBatchOnFunctionError: true,
        // Stream-mapping defaults are UNBOUNDED retries/age: one stuck record would block
        // every later dispatch on its shard for the stream's 24h retention. Retries are
        // safe (receipts and schedules are idempotent), so bound them and fail out to the
        // on-failure queue (alarmed) instead.
        maximumRetryAttempts: 3,
        // The whole tone ladder is done within minutes; a dispatch still unsent after
        // 15 minutes is a missed page to investigate from the on-failure queue, not one
        // to deliver late.
        maximumRecordAgeInSeconds: 900,
        destinationConfig: { onFailure: { destinationArn: this.onFailureQueue.arn } },
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                eventName: ["INSERT"],
                dynamodb: { NewImage: { entityType: { S: ["DISPATCH_ALERT"] } } },
              }),
            },
          ],
        },
      },
      { parent: this, dependsOn: [onFailurePolicy, ...cmkPolicies] },
    );

    this.registerOutputs({
      lambda: this.lambda,
      eventSourceMapping: this.eventSourceMapping,
      onFailureQueue: this.onFailureQueue,
    });
  }
}
