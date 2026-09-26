import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface EventsArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E3-S4-INFRA #217: drill/training event scheduling with member sign-up. createEventHandler
 * (Cedar CreateTrainingEvent) and signupHandler (self-signup, or attendance recording under
 * Cedar RecordTrainingAttendance when the caller posts attendees) need the policy store env
 * var; listEventsHandler self-gates on the shared authorizer claims alone.
 */
export class Events extends pulumi.ComponentResource {
  public readonly createLambda: ServiceLambda;
  public readonly listLambda: ServiceLambda;
  public readonly signupLambda: ServiceLambda;

  constructor(name: string, args: EventsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Events", args.env);
    super("boxalarm:training:Events", name, {}, opts);
    const { env } = args;

    // createEventHandler: createTrainingEvent is a single Put.
    const createStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "TrainingEventsCreateAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:PutItem"],
        Resource: [arn],
      },
    ]);
    // listEventsHandler: listTrainingEvents Queries GSI3, listMemberAttendanceEventIds
    // Queries GSI1 — read-only, index-only.
    const listStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "TrainingEventsListAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:Query"],
        Resource: [`${arn}/index/GSI3`, `${arn}/index/GSI1`],
      },
    ]);
    // signupHandler: getTrainingEvent (GetItem), self-signup createSignupAttendance (PutItem),
    // and officer attendance recording — recordAttendanceHours, a transaction of Update
    // items that IAM authorizes as UpdateItem.
    const signupStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "TrainingEventsSignupAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        Resource: [arn],
      },
      auditMutationDenyStatement(arn),
    ]);
    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-events-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "events-create"),
        logGroup: args.logGroup,
        environment: {
          TRAINING_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([createStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      { routeKey: "POST /api/v1/training/events", lambda: this.createLambda },
      { parent: this },
    );

    this.listLambda = new ServiceLambda(
      `${name}-list`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-events-list`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "events-list"),
        logGroup: args.logGroup,
        environment: { TRAINING_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: listStatement,
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-list-route`,
      { routeKey: "GET /api/v1/training/events", lambda: this.listLambda },
      { parent: this },
    );

    this.signupLambda = new ServiceLambda(
      `${name}-signup`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-events-signup`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "events-signup"),
        logGroup: args.logGroup,
        environment: {
          TRAINING_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([signupStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-signup-route`,
      {
        routeKey: "POST /api/v1/training/events/{eventId}/signup",
        lambda: this.signupLambda,
      },
      { parent: this },
    );

    this.registerOutputs({
      createLambda: this.createLambda,
      listLambda: this.listLambda,
      signupLambda: this.signupLambda,
    });
  }
}
