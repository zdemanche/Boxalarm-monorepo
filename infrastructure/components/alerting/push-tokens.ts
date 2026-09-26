import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { HttpApi } from "../api/http-api";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { AlertingRoute, verifiedPermissionsStatement } from "./route-lambda";
import { grantAlertingCmk } from "./alerting-cmk";

const MEMBER_UPDATED_RESERVED_CONCURRENCY = 5;

export interface PushTokensArgs {
  env: string;
  httpApi: HttpApi;
  platformTableArn: pulumi.Input<string>;
  platformTableName: pulumi.Input<string>;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  personnelLogGroup: ServiceLogGroup;
  alertingLogGroup: ServiceLogGroup;
  policyStoreId: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  alertingPermissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Register/rotate device push tokens (E1-S14-INFRA): the personnel-service routes
 * (platform table only) and the alerting-plane `personnel.member.updated` consumer that
 * merges token changes into the eligibility snapshot (alerting table only — never reads
 * the platform table, preserving the isolation boundary).
 */
export class PushTokens extends pulumi.ComponentResource {
  public readonly registerRoute: AlertingRoute;
  public readonly revokeRoute: AlertingRoute;
  public readonly memberUpdatedConsumer: ServiceLambda;
  public readonly memberUpdatedQueue: aws.sqs.Queue;
  public readonly memberUpdatedDlq: aws.sqs.Queue;
  public readonly memberUpdatedRule: aws.cloudwatch.EventRule;
  public readonly memberUpdatedEventSource: aws.lambda.EventSourceMapping;

  constructor(name: string, args: PushTokensArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("PushTokens", args.env);
    super("boxalarm:alerting:PushTokens", name, {}, opts);
    const { env } = args;

    const personnelTableStatements: IamPolicyStatement[] = [
      {
        Sid: "PlatformTableReadWrite",
        Effect: "Allow",
        // registerToken/revokeToken issue one TransactWriteCommand with an Update (member
        // METADATA) and a Put (OUTBOX_ENTRY). DynamoDB authorizes each transaction item as
        // its own action, so TransactWriteItems alone authorizes nothing.
        Action: [
          "dynamodb:GetItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem",
          "dynamodb:PutItem",
        ],
        Resource: args.platformTableArn as string,
      },
      verifiedPermissionsStatement(),
    ];
    const personnelEnv = {
      PERSONNEL_TABLE_NAME: args.platformTableName,
      PLATFORM_TABLE_NAME: args.platformTableName,
      PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };

    // src/services/personnel-service/pushTokens/registerToken.handler
    this.registerRoute = new AlertingRoute(
      `${name}-register`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.personnelLogGroup,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-push-tokens-register`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "push-tokens-register"),
        routeKey: "POST /api/v1/personnel/members/{memberId}/push-tokens",
        environment: personnelEnv,
        additionalPolicyStatements: personnelTableStatements,
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    // src/services/personnel-service/pushTokens/revokeToken.handler
    this.revokeRoute = new AlertingRoute(
      `${name}-revoke`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.personnelLogGroup,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-push-tokens-revoke`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "push-tokens-revoke"),
        routeKey: "DELETE /api/v1/personnel/members/{memberId}/push-tokens",
        environment: personnelEnv,
        additionalPolicyStatements: personnelTableStatements,
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    this.memberUpdatedDlq = new aws.sqs.Queue(
      `${name}-member-updated-dlq`,
      { name: `boxalarm-${env}-alerting-member-updated-dlq` },
      { parent: this },
    );
    this.memberUpdatedQueue = new aws.sqs.Queue(
      `${name}-member-updated-queue`,
      {
        name: `boxalarm-${env}-alerting-member-updated-queue`,
        visibilityTimeoutSeconds: 30,
        redrivePolicy: this.memberUpdatedDlq.arn.apply((arn) =>
          JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }),
        ),
      },
      { parent: this },
    );

    // Match the producer too, not just the detail-type: the platform outbox publisher puts
    // each row under its own `source` (packages/outbox drainHandler, no override), and every
    // personnel.member.updated writer stamps `personnel-service`. Without it any producer on
    // the platform bus could inject eligibility/contact changes into the alerting snapshot.
    const rule = new aws.cloudwatch.EventRule(
      `${name}-member-updated-rule`,
      {
        name: `boxalarm-${env}-alerting-member-updated`,
        eventBusName: args.busName,
        eventPattern: JSON.stringify({
          source: ["personnel-service"],
          "detail-type": ["personnel.member.updated"],
        }),
      },
      { parent: this },
    );
    this.memberUpdatedRule = rule;

    new aws.sqs.QueuePolicy(
      `${name}-member-updated-queue-policy`,
      {
        queueUrl: this.memberUpdatedQueue.url,
        policy: pulumi.all([this.memberUpdatedQueue.arn, rule.arn]).apply(([queueArn, ruleArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowMemberUpdatedRuleOnly",
                Effect: "Allow",
                Principal: { Service: "events.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: queueArn,
                Condition: { ArnEquals: { "aws:SourceArn": ruleArn } },
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    new aws.cloudwatch.EventTarget(
      `${name}-member-updated-target`,
      { rule: rule.name, eventBusName: args.busName, arn: this.memberUpdatedQueue.arn },
      { parent: this },
    );

    // src/services/alerting-service/eligibility/memberUpdatedHandler.handler
    this.memberUpdatedConsumer = new ServiceLambda(
      `${name}-member-updated-fn`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-member-updated-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "member-updated-consumer"),
        logGroup: args.alertingLogGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableWrite",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
            Resource: args.alertingTableArn as string,
          },
        ],
        reservedConcurrentExecutions: MEMBER_UPDATED_RESERVED_CONCURRENCY,
        permissionsBoundaryArn: args.alertingPermissionsBoundaryArn,
      },
      { parent: this },
    );

    this.memberUpdatedEventSource = new aws.lambda.EventSourceMapping(
      `${name}-member-updated-event-source`,
      {
        eventSourceArn: this.memberUpdatedQueue.arn,
        functionName: this.memberUpdatedConsumer.function.name,
        functionResponseTypes: ["ReportBatchItemFailures"],
        // Pinned to reserved concurrency: throttled receives count toward maxReceiveCount,
        // so a bulk roster change could otherwise push member updates to the DLQ early.
        scalingConfig: { maximumConcurrency: MEMBER_UPDATED_RESERVED_CONCURRENCY },
      },
      { parent: this },
    );

    // The event source mapping cannot drain the queue unless the consumer role
    // can receive and delete. Without this, personnel.member.updated lands and
    // sits until it ages into the DLQ, and the alerting snapshot never updates.
    new aws.iam.RolePolicy(
      `${name}-member-updated-consume-policy`,
      {
        role: this.memberUpdatedConsumer.role.id,
        policy: this.memberUpdatedQueue.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ConsumeMemberUpdatedQueue",
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

    // The member-updated DLQ alarm lives in AlertingAlarms (alarms.ts), which owns the
    // alerting-page topic it must page through.

    grantAlertingCmk(
      name,
      { memberUpdatedConsumer: this.memberUpdatedConsumer.role },
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({
      registerRoute: this.registerRoute,
      revokeRoute: this.revokeRoute,
      memberUpdatedConsumer: this.memberUpdatedConsumer,
    });
  }
}
