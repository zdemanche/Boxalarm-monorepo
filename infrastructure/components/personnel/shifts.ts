import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface ShiftsArgs {
  env: string;
  deptId: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E2-S7 through E2-S11-INFRA (#209-#213): duty shift definition, atomic claim/swap/release,
 * coverage visibility. shifts/handler.ts is a single router Lambda (routes on rawPath +
 * method internally) — one Lambda behind every /personnel/shifts... route, so the ANY
 * routes below all target the same function.
 */
export class Shifts extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly completionLambda: ServiceLambda;
  public readonly completionDlq: aws.sqs.Queue;
  public readonly completionDlqAlarm: aws.cloudwatch.MetricAlarm;
  public readonly completionErrorsAlarm: aws.cloudwatch.MetricAlarm;
  public readonly completionSchedulerRole: aws.iam.Role;
  public readonly completionSchedule: aws.scheduler.Schedule;

  constructor(name: string, args: ShiftsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Shifts", args.env);
    super("boxalarm:personnel:Shifts", name, {}, opts);
    const { env } = args;

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-shifts`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "shifts"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              // ConditionCheckItem: proposeShiftSwap's transaction opens with a
              // ConditionCheck item (shiftSwap.ts), which IAM authorizes on its own action.
              Sid: "ShiftsTableAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:ConditionCheckItem",
                "dynamodb:Query",
              ],
              Resource: [tableArn, `${tableArn}/index/GSI3`],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
            auditMutationDenyStatement(tableArn),
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-collection-route`,
      { routeKey: "ANY /api/v1/personnel/shifts", lambda: this.lambda },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-proxy-route`,
      { routeKey: "ANY /api/v1/personnel/shifts/{proxy+}", lambda: this.lambda },
      { parent: this },
    );

    // #213: hourly shift-completion sweep -> completionHandler.ts, writing
    // ATTENDANCE_RECORD + OUTBOX_ENTRY (personnel.attendance.recorded) via
    // completeShiftAttendance.ts's transaction.
    this.completionLambda = new ServiceLambda(
      `${name}-completion`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-shift-completion`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "shift-completion"),
        logGroup: args.logGroup,
        environment: { PLATFORM_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi.output(args.platformTableArn).apply((tableArn) => [
          {
            Sid: "ShiftCompletionQuery" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:Query"],
            Resource: [tableArn, `${tableArn}/index/GSI3`],
          },
          {
            // completeShiftAttendance's transaction: Put items (attendance + outbox rows)
            // plus an Update (shift METADATA), authorized item-by-item —
            // dynamodb:TransactWriteItems is not an IAM action.
            Sid: "ShiftCompletionWrite" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
            Resource: [tableArn],
          },
          auditMutationDenyStatement(tableArn),
        ]),
      },
      { parent: this },
    );

    this.completionDlq = new aws.sqs.Queue(
      `${name}-completion-dlq`,
      { name: `boxalarm-${env}-personnel-shift-completion-dlq` },
      { parent: this },
    );

    this.completionDlqAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-completion-dlq-depth-alarm`,
      {
        name: `boxalarm-${env}-personnel-shift-completion-dlq-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.completionDlq.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.completionErrorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-completion-errors-alarm`,
      {
        name: `boxalarm-${env}-personnel-shift-completion-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.completionLambda.function.name },
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.completionSchedulerRole = new aws.iam.Role(
      `${name}-completion-scheduler-role`,
      {
        name: `boxalarm-${env}-personnel-shift-completion-scheduler`,
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

    new aws.iam.RolePolicy(
      `${name}-completion-scheduler-role-policy`,
      {
        role: this.completionSchedulerRole.id,
        policy: pulumi
          .all([this.completionLambda.function.arn, this.completionDlq.arn])
          .apply(([lambdaArn, dlqArn]) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "InvokeShiftCompletion",
                  Effect: "Allow",
                  Action: "lambda:InvokeFunction",
                  Resource: lambdaArn,
                },
                {
                  Sid: "ShiftCompletionSchedulerDlq",
                  Effect: "Allow",
                  Action: "sqs:SendMessage",
                  Resource: dlqArn,
                },
              ],
            }),
          ),
      },
      { parent: this },
    );

    this.completionSchedule = new aws.scheduler.Schedule(
      `${name}-completion-schedule`,
      {
        name: `boxalarm-${env}-personnel-shift-completion-hourly`,
        scheduleExpression: "rate(1 hour)",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: this.completionLambda.function.arn,
          roleArn: this.completionSchedulerRole.arn,
          input: JSON.stringify({ deptId: args.deptId }),
          retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 3600 },
          deadLetterConfig: { arn: this.completionDlq.arn },
        },
      },
      { parent: this },
    );

    this.registerOutputs({
      lambda: this.lambda,
      completionLambda: this.completionLambda,
      completionSchedule: this.completionSchedule,
    });
  }
}
