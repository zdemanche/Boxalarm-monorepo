import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { grantAlertingCmk } from "./alerting-cmk";

const DEFAULT_SCHEDULE_RATE_MINUTES = 2;
const CANARY_METRIC_NAMESPACE = "Boxalarm/AlertingCanary";
const LATENCY_BUDGET_MS = 5_000;

export interface AlertingCanaryArgs {
  env: string;
  deptId: string;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  pageTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Continuous production canary (E1-S10-INFRA #230/#35): a recurring EventBridge
 * Scheduler invocation of the canary runner Lambda, on-call alarms on the
 * `Boxalarm/AlertingCanary` namespace the runner emits (canary/handler.ts) with
 * `TreatMissingData: breaching` so a canary that stops running pages, and the canary
 * member's endpoint secrets. No SQS permission is granted — the runner reports failures
 * purely via EMF (console.log), not a direct PutMetricData call.
 */
export class AlertingCanary extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly schedule: aws.scheduler.Schedule;
  public readonly failureAlarm: aws.cloudwatch.MetricAlarm;
  public readonly latencyAlarm: aws.cloudwatch.MetricAlarm;
  public readonly errorsAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: AlertingCanaryArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertingCanary", args.env);
    super("boxalarm:alerting:AlertingCanary", name, {}, opts);
    const { env, deptId } = args;

    const config = new pulumi.Config("boxalarm-infra");
    const rateMinutes =
      config.getNumber("canaryScheduleRateMinutes") ?? DEFAULT_SCHEDULE_RATE_MINUTES;
    // Off unless a stack opts in with `boxalarm-infra:canaryEnabled: true`. Every tick sends
    // to the canary member on every channel, so a stack runs it only on purpose. While it is
    // off, its breaching-on-missing alarms must not page, so their actions are disabled too.
    const canaryEnabled = config.getBoolean("canaryEnabled") ?? false;
    const canaryMemberId = config.requireSecret("canaryMemberId");

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-canary`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "canary"),
        logGroup: args.logGroup,
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          CANARY_DEPT_ID: deptId,
          CANARY_MEMBER_ID: canaryMemberId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableCanaryReadWrite",
            Effect: "Allow",
            // canary/handler.ts: Get (pointer, self-test run), Put (pointer, CANARY_RUN,
            // self-test run, cooldown), Delete (clearCanaryPointer), and createManualDispatch's
            // TransactWriteCommand, whose Put items are authorized as PutItem.
            Action: [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:DeleteItem",
              "dynamodb:Query",
              "dynamodb:TransactWriteItems",
            ],
            Resource: args.alertingTableArn as string,
          },
        ],
        reservedConcurrentExecutions: 2,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    const schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-alerting-canary-scheduler`,
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

    new aws.iam.RolePolicy(
      `${name}-scheduler-role-policy`,
      {
        role: schedulerRole.id,
        policy: this.lambda.function.arn.apply((fnArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeCanaryOnly",
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: fnArn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.schedule = new aws.scheduler.Schedule(
      `${name}-schedule`,
      {
        name: `boxalarm-${env}-alerting-${deptId}-canary`,
        scheduleExpression: `rate(${rateMinutes} minutes)`,
        state: canaryEnabled ? "ENABLED" : "DISABLED",
        flexibleTimeWindow: { mode: "OFF" },
        target: { arn: this.lambda.function.arn, roleArn: schedulerRole.arn },
      },
      { parent: this },
    );

    this.failureAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-failure-alarm`,
      {
        name: `boxalarm-${env}-alerting-canary-failed`,
        namespace: CANARY_METRIC_NAMESPACE,
        metricName: "CanaryFailed",
        statistic: "Sum",
        comparisonOperator: "GreaterThanOrEqualToThreshold",
        threshold: 1,
        period: 300,
        evaluationPeriods: 1,
        treatMissingData: "breaching",
        actionsEnabled: canaryEnabled,
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    this.latencyAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-latency-alarm`,
      {
        name: `boxalarm-${env}-alerting-canary-latency-high`,
        namespace: CANARY_METRIC_NAMESPACE,
        metricName: "CanaryLatencyMs",
        statistic: "Maximum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: LATENCY_BUDGET_MS,
        period: 300,
        evaluationPeriods: 1,
        treatMissingData: "breaching",
        actionsEnabled: canaryEnabled,
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    // A canary Lambda that throws (e.g. missing config) emits no CanaryFailed of its own.
    this.errorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-errors-alarm`,
      {
        name: `boxalarm-${env}-alerting-canary-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.lambda.function.name },
        statistic: "Sum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 60,
        evaluationPeriods: 1,
        treatMissingData: "notBreaching",
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    grantAlertingCmk(name, { canary: this.lambda.role }, args.alertingCmkArn, { parent: this });

    this.registerOutputs({
      lambda: this.lambda,
      schedule: this.schedule,
      failureAlarm: this.failureAlarm,
      latencyAlarm: this.latencyAlarm,
      errorsAlarm: this.errorsAlarm,
    });
  }
}
