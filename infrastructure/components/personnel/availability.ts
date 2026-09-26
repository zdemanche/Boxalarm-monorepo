import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";
import { PlatformBus } from "../messaging/platform-bus";
import { QueueConsumer } from "../messaging/queue-consumer";
import { grantAlertingCmk } from "../alerting/alerting-cmk";

export interface AvailabilityArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
  platformBus: PlatformBus;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  alertingLogGroup: ServiceLogGroup;
  alertingPermissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * E2-S5-INFRA #207: planned unavailability (marking off) that suppresses alerting.
 * createAvailability creates one or two one-time EventBridge Scheduler schedules per
 * markoff (ACTIVATE/REVERT) targeting expiryHandler — the scheduler role is provisioned
 * here and its ARN + expiryHandler's ARN are handed to the create Lambda by env var, per
 * availability/handler.ts's readSchedulerConfig.
 */
export class Availability extends pulumi.ComponentResource {
  public readonly expiryLambda: ServiceLambda;
  public readonly createLambda: ServiceLambda;
  public readonly schedulerRole: aws.iam.Role;
  public readonly availabilityChangedConsumer: ServiceLambda;
  public readonly availabilityChangedQueueConsumer: QueueConsumer;

  constructor(name: string, args: AvailabilityArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Availability", args.env);
    super("boxalarm:personnel:Availability", name, {}, opts);
    const { env } = args;

    const tableStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "AvailabilityTableAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        Resource: [arn],
      },
      // F9.4: holding table-wide UpdateItem, never on a DEPT#*#AUDIT#* row.
      auditMutationDenyStatement(arn),
    ]);

    this.expiryLambda = new ServiceLambda(
      `${name}-expiry`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-availability-expiry`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "availability-expiry"),
        logGroup: args.logGroup,
        environment: { PLATFORM_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: tableStatement,
      },
      { parent: this },
    );

    this.schedulerRole = new aws.iam.Role(
      `${name}-scheduler-role`,
      {
        name: `boxalarm-${env}-personnel-availability-scheduler`,
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
      `${name}-scheduler-role-policy`,
      {
        role: this.schedulerRole.id,
        policy: this.expiryLambda.function.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeAvailabilityExpiry",
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: arn,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    // availability/handler.ts creates/deletes schedules named avail-* in the default
    // group of this account and region only.
    const region = aws.getRegionOutput({}, { parent: this });
    const caller = aws.getCallerIdentityOutput({}, { parent: this });
    const scheduleResourcePattern = pulumi.interpolate`arn:aws:scheduler:${region.name}:${caller.accountId}:schedule/default/avail-*`;

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-availability-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "availability-create"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
          AVAILABILITY_EXPIRY_HANDLER_ARN: this.expiryLambda.function.arn,
          AVAILABILITY_SCHEDULER_ROLE_ARN: this.schedulerRole.arn,
        },
        additionalPolicyStatements: pulumi
          .all([
            tableStatement,
            pulumi.output(args.policyStoreArn),
            this.schedulerRole.arn,
            scheduleResourcePattern,
          ])
          .apply(([table, policyStoreArn, schedulerRoleArn, schedulePattern]) => [
            ...table,
            verifiedPermissionsPolicyStatement(policyStoreArn),
            {
              Sid: "AvailabilityManageSchedules" as const,
              Effect: "Allow" as const,
              Action: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"],
              Resource: schedulePattern,
            },
            {
              Sid: "AvailabilityPassSchedulerRole" as const,
              Effect: "Allow" as const,
              Action: ["iam:PassRole"],
              Resource: schedulerRoleArn,
            },
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      {
        routeKey: "POST /api/v1/personnel/members/{memberId}/availability",
        lambda: this.createLambda,
      },
      { parent: this },
    );

    // #207: personnel.availability.changed -> availability-snapshot-queue ->
    // alerting-service's eligibility/consumer.ts, alerting-table-only (IAM boundary).
    this.availabilityChangedConsumer = new ServiceLambda(
      `${name}-availability-changed-consumer`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-availability-changed-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "availability-changed-consumer"),
        logGroup: args.alertingLogGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName },
        additionalPolicyStatements: pulumi.output(args.alertingTableArn).apply((arn) => [
          {
            // eligibility/consumer.ts: one transaction of Put (dedup marker) + Update
            // (MEMBER_ELIGIBILITY_SNAPSHOT) items, authorized item-by-item —
            // dynamodb:TransactWriteItems is not an IAM action.
            Sid: "AlertingTableWrite" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
            Resource: [arn],
          },
        ]),
        permissionsBoundaryArn: args.alertingPermissionsBoundaryArn,
      },
      { parent: this },
    );

    this.availabilityChangedQueueConsumer = args.platformBus.addQueueConsumer(
      `${name}-availability-changed-queue-consumer`,
      {
        env,
        ruleName: `boxalarm-${env}-availability-changed`,
        eventPattern: JSON.stringify({ "detail-type": ["personnel.availability.changed"] }),
        queueName: `boxalarm-${env}-availability-snapshot-queue`,
        lambda: this.availabilityChangedConsumer.function,
        lambdaRole: this.availabilityChangedConsumer.role,
        maxReceiveCount: 5,
      },
      { parent: this },
    );

    grantAlertingCmk(
      name,
      { availabilityChangedConsumer: this.availabilityChangedConsumer.role },
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({
      expiryLambda: this.expiryLambda,
      createLambda: this.createLambda,
      schedulerRole: this.schedulerRole,
      availabilityChangedConsumer: this.availabilityChangedConsumer,
    });
  }
}
