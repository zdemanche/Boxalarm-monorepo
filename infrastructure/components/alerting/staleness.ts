import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { grantAlertingCmk } from "./alerting-cmk";

export interface EligibilityStalenessArgs {
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
 * Eligibility-snapshot staleness check (E1-S13-INFRA): a recurring 5-minute schedule per
 * department invoking `eligibility/staleness/checkHandler.handler`, and an alarm on the
 * `SnapshotStale` metric it emits under `Boxalarm/alerting-eligibility` (namespace as
 * emitted by the handler, not the title-cased form in the ticket text).
 *
 * boxalarm-backend#32: the handler currently measures absolute snapshot age, not
 * propagation lag, so this alarm can fire permanently for a member with no recent
 * change until the backend metric is corrected — tracked there, not fixed here.
 */
export class EligibilityStaleness extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly schedule: aws.scheduler.Schedule;
  public readonly alarm: aws.cloudwatch.MetricAlarm;
  public readonly errorsAlarm: aws.cloudwatch.MetricAlarm;

  constructor(
    name: string,
    args: EligibilityStalenessArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    requireEnv("EligibilityStaleness", args.env);
    super("boxalarm:alerting:EligibilityStaleness", name, {}, opts);
    const { env, deptId } = args;

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-eligibility-staleness-check`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "eligibility-staleness-check"),
        logGroup: args.logGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName, DEPT_ID: deptId },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableRead",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
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
        name: `boxalarm-${env}-alerting-staleness-scheduler`,
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
        // Same alerting-plane boundary as the canary and escalation scheduler roles.
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
                Sid: "InvokeStalenessCheckOnly",
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
        name: `boxalarm-${env}-alerting-${deptId}-eligibility-staleness`,
        scheduleExpression: "rate(5 minutes)",
        flexibleTimeWindow: { mode: "OFF" },
        target: { arn: this.lambda.function.arn, roleArn: schedulerRole.arn },
      },
      { parent: this },
    );

    this.alarm = new aws.cloudwatch.MetricAlarm(
      `${name}-alarm`,
      {
        name: `boxalarm-${env}-alerting-eligibility-snapshot-stale`,
        namespace: "Boxalarm/alerting-eligibility",
        metricName: "SnapshotStale",
        statistic: "Maximum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 300,
        evaluationPeriods: 1,
        treatMissingData: "notBreaching",
        // Deliberately NO alarmActions (dashboard-only) until the backend measures propagation
        // lag instead of absolute snapshot age (boxalarm-backend#32, pre-monorepo number; see
        // the class comment and the PR #326 review). As measured today, any member unchanged
        // for 15 minutes is "stale", so this alarm sits in ALARM permanently and routing it to
        // alerting-page would bury real pages under a constant noise floor. Restore
        // `alarmActions: [args.pageTopicArn]` when the metric is fixed.
      },
      { parent: this },
    );

    // The SnapshotStale alarm treats missing data as notBreaching, so a check that throws
    // (checkHandler) would otherwise go silent. This one pages.
    this.errorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-errors-alarm`,
      {
        name: `boxalarm-${env}-alerting-eligibility-staleness-check-errors`,
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

    grantAlertingCmk(name, { stalenessCheck: this.lambda.role }, args.alertingCmkArn, {
      parent: this,
    });

    this.registerOutputs({
      lambda: this.lambda,
      schedule: this.schedule,
      alarm: this.alarm,
      errorsAlarm: this.errorsAlarm,
    });
  }
}
