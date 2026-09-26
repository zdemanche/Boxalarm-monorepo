import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { QueueConsumer } from "../messaging/queue-consumer";
import { nerisClientPolicyStatements } from "../neris/neris-config";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface NerisSubmissionWorkerArgs {
  env: string;
  incidentTableName: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
  incidentCmkArn: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  busArn: pulumi.Input<string>;
  nerisCredentialsSecretArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/** Name prefix submissionWorker.ts gives every retry schedule it creates. */
export const SUBMISSION_RETRY_SCHEDULE_PREFIX = "neris-submission-retry-";

/**
 * NERIS submission worker (incident-service/neris/submissionWorker.ts). The handler
 * accepts exactly two invocation shapes, and both are wired here:
 *
 *  1. An SQS batch of EventBridge envelopes for `neris.incident.submitted` (written to
 *     the incident outbox by submit/retry and published by IncidentOutboxDrain). It
 *     returns `batchItemFailures`, so the mapping opts into ReportBatchItemFailures.
 *  2. A direct invoke from a one-time EventBridge Scheduler schedule
 *     (`{deptId, incidentId, retryCount}`) that the worker itself creates for
 *     backoff retries. CreateSchedule passes no GroupName, so schedules land in the
 *     `default` group; the worker may create only `neris-submission-retry-*` there,
 *     and the scheduler role it passes may only invoke this function.
 */
export class NerisSubmissionWorker extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly schedulerRole: aws.iam.Role;
  public readonly consumer: QueueConsumer;
  public readonly scheduleResourcePattern: pulumi.Output<string>;

  constructor(
    name: string,
    args: NerisSubmissionWorkerArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    requireEnv("NerisSubmissionWorker", args.env);
    super("boxalarm:incident:NerisSubmissionWorker", name, {}, opts);
    const { env } = args;

    const region = aws.getRegionOutput({}, { parent: this });
    const caller = aws.getCallerIdentityOutput({}, { parent: this });
    this.scheduleResourcePattern = pulumi.interpolate`arn:aws:scheduler:${region.name}:${caller.accountId}:schedule/default/${SUBMISSION_RETRY_SCHEDULE_PREFIX}*`;

    this.schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-incident-neris-submission-scheduler`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "scheduler.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      },
      { parent: this },
    );

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-submission-worker`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "submission-worker"),
        logGroup: args.logGroup,
        // One outbound NERIS POST plus SSM/Secrets reads on a cold start; the 3s Lambda
        // default would misclassify a slow NERIS response as a failure. Kept under the
        // queue's default 30s visibility timeout, which AWS requires.
        timeout: 25,
        environment: {
          INCIDENT_TABLE_NAME: args.incidentTableName,
          NERIS_BASE_URL_PARAM: `/boxalarm/${env}/neris/base-url`,
          NERIS_USER_AGENT_PARAM: `/boxalarm/${env}/neris/user-agent`,
          NERIS_CREDENTIALS_SECRET_ID: args.nerisCredentialsSecretArn,
          NERIS_SUBMISSION_SCHEDULER_ROLE_ARN: this.schedulerRole.arn,
          // neris/config.ts decides prod vs non-prod from STAGE ?? BOXALARM_ENV;
          // ServiceLambda only sets ENVIRONMENT. Without this, prod would treat itself
          // as non-prod and fail closed against the NERIS production host (N6.4).
          BOXALARM_ENV: env,
        },
        additionalPolicyStatements: pulumi
          .all([
            args.incidentTableArn,
            args.incidentCmkArn,
            args.nerisCredentialsSecretArn,
            this.scheduleResourcePattern,
          ])
          .apply(([tableArn, cmkArn, secretArn, schedulePattern]) => [
            {
              // getIncident + appendSubmissionAttempt's TransactWrite (attempt Put,
              // submission Update, optional neris.submission.failed outbox Put).
              Sid: "IncidentSubmissionAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
              Resource: [tableArn],
            },
            {
              Sid: "IncidentCmkAccess" as const,
              Effect: "Allow" as const,
              Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
              Resource: [cmkArn],
            },
            ...nerisClientPolicyStatements(secretArn, env),
            {
              Sid: "CreateSubmissionRetrySchedulesOnly" as const,
              Effect: "Allow" as const,
              Action: ["scheduler:CreateSchedule"],
              Resource: schedulePattern,
            },
          ]),
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-pass-scheduler-role`,
      {
        role: this.lambda.role.id,
        policy: this.schedulerRole.arn.apply((roleArn) =>
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

    new aws.iam.RolePolicy(
      `${name}-scheduler-role-policy`,
      {
        role: this.schedulerRole.id,
        policy: this.lambda.function.arn.apply((functionArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeSubmissionWorkerOnly",
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: functionArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.consumer = new QueueConsumer(
      `${name}-consumer`,
      {
        env,
        busName: args.busName,
        busArn: args.busArn,
        ruleName: `boxalarm-${env}-incident-neris-submission`,
        eventPattern: JSON.stringify({
          source: ["incident-service"],
          "detail-type": ["neris.incident.submitted"],
        }),
        queueName: `boxalarm-${env}-incident-neris-submission-queue`,
        lambda: this.lambda.function,
        lambdaRole: this.lambda.role,
        maxReceiveCount: 5,
        reportBatchItemFailures: true,
      },
      { parent: this },
    );

    this.registerOutputs({
      lambda: this.lambda,
      schedulerRole: this.schedulerRole,
      consumer: this.consumer,
    });
  }
}
