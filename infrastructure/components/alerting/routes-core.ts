import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { HttpApi } from "../api/http-api";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { AlertingRoute, verifiedPermissionsStatement } from "./route-lambda";
import { Escalation } from "./escalation";
import { grantAlertingCmk } from "./alerting-cmk";

export interface RoutesCoreArgs {
  env: string;
  httpApi: HttpApi;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  escalation: Escalation;
  policyStoreId: pulumi.Input<string>;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Core alerting-service routes, each with its own reserved concurrency separate from
 * fan-out and the channel workers (E1-S1/S5/S6-INFRA): manual dispatch ingress
 * (degraded-mode fallback), response confirmation, live roster, and dispatch detail.
 */
export class RoutesCore extends pulumi.ComponentResource {
  public readonly dispatchIngress: AlertingRoute;
  public readonly responses: AlertingRoute;
  public readonly roster: AlertingRoute;
  public readonly detail: AlertingRoute;

  constructor(name: string, args: RoutesCoreArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("RoutesCore", args.env);
    super("boxalarm:alerting:RoutesCore", name, {}, opts);
    const { env } = args;

    const alertingTableStatements: pulumi.Input<IamPolicyStatement[]> =
      args.escalation.scheduleResourcePattern.apply((schedulePattern) => [
        {
          Sid: "AlertingTableConditionalWrite",
          Effect: "Allow" as const,
          Action: [
            "dynamodb:PutItem",
            "dynamodb:ConditionCheckItem",
            "dynamodb:TransactWriteItems",
          ],
          Resource: args.alertingTableArn as string,
        },
        {
          // runFanOut reads before it writes: queryEligibleMembers is a Query on the
          // ELIGIBILITY partition (eligibility/selector.ts), and the escalation-threshold /
          // tone-ladder config reads are GetItems (scheduleEscalation.ts, toneLadder.ts).
          // Without these the synchronous fan-out fails, is logged, and ingress still
          // returns 201 with nobody paged.
          Sid: "AlertingTableRead",
          Effect: "Allow" as const,
          Action: ["dynamodb:Query", "dynamodb:GetItem"],
          Resource: args.alertingTableArn as string,
        },
        {
          Sid: "CreateEscalationSchedulesOnly",
          Effect: "Allow" as const,
          Action: ["scheduler:CreateSchedule"],
          Resource: schedulePattern,
        },
        verifiedPermissionsStatement(),
      ]);

    // src/services/alerting-service/dispatches/handler.handler — the manual/degraded-mode
    // ingress route; it calls runFanOut synchronously (fanout/fanOut.ts), which schedules
    // the tone-1 voice escalation and the tone-2/3 evaluator timers on the same scheduler
    // role/group as the stream-driven fan-out path.
    this.dispatchIngress = new AlertingRoute(
      `${name}-dispatch-ingress`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-dispatches-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "dispatches-create"),
        routeKey: "POST /api/v1/alerting/dispatches",
        environment: {
          ALERTING_DISPATCHES_TABLE_NAME: args.alertingTableName,
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
          ESCALATION_HANDLER_ARN: args.escalation.lambda.function.arn,
          ESCALATION_SCHEDULER_ROLE_ARN: args.escalation.schedulerRole.arn,
          TONE_EVALUATOR_HANDLER_ARN: args.escalation.toneEvaluatorLambda.function.arn,
          ESCALATION_SCHEDULE_GROUP_NAME: args.escalation.scheduleGroupName,
        },
        additionalPolicyStatements: alertingTableStatements,
        reservedConcurrentExecutions: 5,
        // Serial per-member TransactWrite + GetItem + CreateSchedule for the whole
        // roster; 3s ends a 30-40 member dispatch mid-roster. 29s stays under the
        // HTTP API's 30s integration ceiling.
        timeout: 29,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-dispatch-ingress-pass-scheduler-role`,
      {
        role: this.dispatchIngress.lambda.role.id,
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

    // src/services/alerting-service/responses/handler.handler
    this.responses = new AlertingRoute(
      `${name}-responses`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-responses`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "responses"),
        routeKey: "POST /api/v1/alerting/dispatches/{dispatchId}/responses",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableReadWrite",
            Effect: "Allow",
            Action: [
              "dynamodb:TransactWriteItems",
              "dynamodb:UpdateItem",
              "dynamodb:PutItem",
              "dynamodb:GetItem",
            ],
            Resource: args.alertingTableArn as string,
          },
          verifiedPermissionsStatement(),
        ],
        reservedConcurrentExecutions: 5,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/roster/handler.handler
    this.roster = new AlertingRoute(
      `${name}-roster`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-roster`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "roster"),
        routeKey: "GET /api/v1/alerting/dispatches/{dispatchId}/roster",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableQuery",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          verifiedPermissionsStatement(),
        ],
        reservedConcurrentExecutions: 5,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/dispatches/detail/handler.handler
    this.detail = new AlertingRoute(
      `${name}-detail`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-dispatch-detail`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "dispatch-detail"),
        routeKey: "GET /api/v1/alerting/dispatches/{dispatchId}",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableReadOnly",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          verifiedPermissionsStatement(),
        ],
        reservedConcurrentExecutions: 5,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    grantAlertingCmk(
      name,
      {
        dispatchIngress: this.dispatchIngress.lambda.role,
        responses: this.responses.lambda.role,
        roster: this.roster.lambda.role,
        detail: this.detail.lambda.role,
      },
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({
      dispatchIngress: this.dispatchIngress,
      responses: this.responses,
      roster: this.roster,
      detail: this.detail,
    });
  }
}
