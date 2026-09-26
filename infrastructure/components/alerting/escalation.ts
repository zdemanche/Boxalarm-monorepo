import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { grantAlertingCmk } from "./alerting-cmk";
import { ALERT_PATH_MEMORY_MB } from "./messaging-alerting";

export interface EscalationArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTopicArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Voice escalation plumbing (E1-S3-INFRA): a dedicated EventBridge Scheduler group for
 * per-member T+N one-time timers, a scheduler execution role that may only invoke the
 * escalation Lambda, and the escalation Lambda itself.
 */
export class Escalation extends pulumi.ComponentResource {
  public readonly scheduleGroup: aws.scheduler.ScheduleGroup;
  public readonly schedulerRole: aws.iam.Role;
  public readonly lambda: ServiceLambda;
  public readonly toneEvaluatorLambda: ServiceLambda;
  /** ARN pattern scoping scheduler:CreateSchedule to schedules within this group only. */
  public readonly scheduleResourcePattern: pulumi.Output<string>;
  /**
   * Cross-seam contract: every Lambda that creates schedules gets this as
   * ESCALATION_SCHEDULE_GROUP_NAME and passes it as CreateSchedule's GroupName
   * (scheduleEscalation.ts / toneLadder.ts). Without it the schedule lands in the
   * `default` group, outside scheduleResourcePattern, and is denied.
   */
  public readonly scheduleGroupName: pulumi.Output<string>;

  constructor(name: string, args: EscalationArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Escalation", args.env);
    super("boxalarm:alerting:Escalation", name, {}, opts);
    const { env } = args;
    const groupName = `boxalarm-${env}-alerting-escalation`;

    this.scheduleGroup = new aws.scheduler.ScheduleGroup(
      `${name}-group`,
      { name: groupName },
      { parent: this },
    );

    this.scheduleGroupName = this.scheduleGroup.name;

    const region = aws.getRegionOutput({}, { parent: this });
    const caller = aws.getCallerIdentityOutput({}, { parent: this });
    this.scheduleResourcePattern = pulumi.interpolate`arn:aws:scheduler:${region.name}:${caller.accountId}:schedule/${groupName}/*`;

    const escalationPolicy: pulumi.Input<IamPolicyStatement[]> = pulumi
      .all([args.alertingTableArn, args.alertingTopicArn])
      .apply(([tableArn, topicArn]) => [
        {
          Sid: "AlertingTableReadWrite",
          Effect: "Allow" as const,
          Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          Resource: tableArn,
        },
        {
          Sid: "AlertingTableTransact",
          Effect: "Allow" as const,
          Action: ["dynamodb:TransactWriteItems"],
          Resource: tableArn,
        },
        {
          Sid: "AlertingTopicPublish",
          Effect: "Allow" as const,
          Action: ["sns:Publish"],
          Resource: topicArn,
        },
      ]);

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-escalation`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "escalation"),
        logGroup: args.logGroup,
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          ALERTING_TOPIC_ARN: args.alertingTopicArn,
        },
        additionalPolicyStatements: escalationPolicy,
        reservedConcurrentExecutions: 5,
        // Roster GetItem, TransactWrite, SNS publish — explicit rather than the 3s default.
        timeout: 15,
        memorySize: ALERT_PATH_MEMORY_MB,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    this.schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-alerting-escalation-scheduler`,
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
        permissionsBoundary: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // Tone-ladder evaluator (E1-S3/E1-S15-INFRA): fired by the tone-2/tone-3 one-time
    // schedules toneLadder.ts creates via this same scheduler role, and itself schedules
    // each member's voice escalation on the escalation Lambda above.
    this.toneEvaluatorLambda = new ServiceLambda(
      `${name}-tone-evaluator-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-tone-evaluator`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "tone-evaluator"),
        logGroup: args.logGroup,
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          ALERTING_TOPIC_ARN: args.alertingTopicArn,
          ESCALATION_HANDLER_ARN: this.lambda.function.arn,
          ESCALATION_SCHEDULER_ROLE_ARN: this.schedulerRole.arn,
          ESCALATION_SCHEDULE_GROUP_NAME: this.scheduleGroupName,
        },
        additionalPolicyStatements: pulumi
          .all([args.alertingTableArn, args.alertingTopicArn, this.scheduleResourcePattern])
          .apply(([tableArn, topicArn, schedulePattern]) => [
            {
              Sid: "AlertingTableReadWrite",
              Effect: "Allow" as const,
              Action: [
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:TransactWriteItems",
              ],
              Resource: tableArn,
            },
            {
              Sid: "AlertingTopicPublish",
              Effect: "Allow" as const,
              Action: ["sns:Publish"],
              Resource: topicArn,
            },
            {
              Sid: "CreateEscalationSchedulesOnly",
              Effect: "Allow" as const,
              Action: ["scheduler:CreateSchedule"],
              Resource: schedulePattern,
            },
          ]),
        reservedConcurrentExecutions: 5,
        // Roster query, re-page publishes, and per-member escalation scheduling.
        timeout: 30,
        memorySize: ALERT_PATH_MEMORY_MB,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-tone-evaluator-pass-scheduler-role`,
      {
        role: this.toneEvaluatorLambda.role.id,
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
        policy: pulumi
          .all([this.lambda.function.arn, this.toneEvaluatorLambda.function.arn])
          .apply(([escalationArn, toneEvaluatorArn]) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "InvokeEscalationAndToneEvaluatorOnly",
                  Effect: "Allow",
                  Action: "lambda:InvokeFunction",
                  Resource: [escalationArn, toneEvaluatorArn],
                },
              ],
            }),
          ),
      },
      { parent: this },
    );

    grantAlertingCmk(
      name,
      {
        escalation: this.lambda.role,
        toneEvaluator: this.toneEvaluatorLambda.role,
      },
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({
      scheduleGroup: this.scheduleGroup,
      schedulerRole: this.schedulerRole,
      lambda: this.lambda,
      toneEvaluatorLambda: this.toneEvaluatorLambda,
    });
  }
}
