import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { IamPolicyStatement } from "../observability/observability-policy";
import { lambdaCode } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";
import { PlatformBus } from "../messaging/platform-bus";
import { QueueConsumer } from "../messaging/queue-consumer";
import { grantAlertingCmk } from "../alerting/alerting-cmk";

export interface QualsArgs {
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

// GET: readQuals is a base-table Query (pk + begins_with(sk,'QUAL#')) — read-only.
const GET_TABLE_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "QualsTableRead" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:Query"],
      Resource: [arn],
    },
  ]);

// PUT: memberExists + readCertStatus are GetItems; putQual is a 2-Put transaction,
// which IAM authorizes item-by-item as PutItem.
const PUT_TABLE_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "QualsTableWrite" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
      Resource: [arn],
    },
  ]);

/** E2-S2-INFRA #204: qualifications get/put, scoped to the platform table + policy store. */
export class Quals extends pulumi.ComponentResource {
  public readonly getLambda: ServiceLambda;
  public readonly putLambda: ServiceLambda;
  public readonly eligibilityChangedConsumer: ServiceLambda;
  public readonly eligibilityChangedQueueConsumer: QueueConsumer;

  constructor(name: string, args: QualsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Quals", args.env);
    super("boxalarm:personnel:Quals", name, {}, opts);
    const { env } = args;

    // readPersonnelServiceConfig (awsClients.ts) throws unless BOTH the table and bus names
    // are set, on GET and PUT alike — the bus name is required even though quals publishes
    // via the outbox, not events:PutEvents.
    const baseEnvironment = {
      PERSONNEL_TABLE_NAME: args.platformTableName,
      PLATFORM_BUS_NAME: args.platformBus.busName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };
    const withAuthz = (table: pulumi.Output<IamPolicyStatement[]>) =>
      pulumi
        .all([table, pulumi.output(args.policyStoreArn)])
        .apply(([statements, policyStoreArn]) => [
          ...statements,
          verifiedPermissionsPolicyStatement(policyStoreArn),
        ]);
    // One bundle (quals/handler.ts exports both getQualsHandler and putQualsHandler) — two
    // Lambdas differ only in which named export they invoke.
    const code = lambdaCode("personnel-service", "quals");

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-quals-get`,
        handler: "index.getQualsHandler",
        code,
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: withAuthz(GET_TABLE_STATEMENT(args.platformTableArn)),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/personnel/members/{memberId}/quals", lambda: this.getLambda },
      { parent: this },
    );

    this.putLambda = new ServiceLambda(
      `${name}-put`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-quals-put`,
        handler: "index.putQualsHandler",
        code,
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: withAuthz(PUT_TABLE_STATEMENT(args.platformTableArn)),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-put-route`,
      { routeKey: "PUT /api/v1/personnel/members/{memberId}/quals", lambda: this.putLambda },
      { parent: this },
    );

    // #114/#204: personnel.eligibility.changed -> eligibility-changed-snapshot-queue ->
    // alerting-service's eligibilityChangedConsumer.ts, alerting-table-only (IAM boundary).
    this.eligibilityChangedConsumer = new ServiceLambda(
      `${name}-eligibility-changed-consumer`,
      {
        env,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-eligibility-changed-consumer`,
        handler: "index.handler",
        code: lambdaCode("alerting-service", "eligibility-changed-consumer"),
        logGroup: args.alertingLogGroup,
        environment: { ALERTING_TABLE_NAME: args.alertingTableName },
        additionalPolicyStatements: pulumi.output(args.alertingTableArn).apply((arn) => [
          {
            Sid: "AlertingTableWrite" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
            Resource: [arn],
          },
        ]),
        permissionsBoundaryArn: args.alertingPermissionsBoundaryArn,
      },
      { parent: this },
    );

    this.eligibilityChangedQueueConsumer = args.platformBus.addQueueConsumer(
      `${name}-eligibility-changed-queue-consumer`,
      {
        env,
        ruleName: `boxalarm-${env}-eligibility-changed`,
        eventPattern: JSON.stringify({ "detail-type": ["personnel.eligibility.changed"] }),
        queueName: `boxalarm-${env}-eligibility-changed-snapshot-queue`,
        lambda: this.eligibilityChangedConsumer.function,
        lambdaRole: this.eligibilityChangedConsumer.role,
        maxReceiveCount: 5,
      },
      { parent: this },
    );

    grantAlertingCmk(
      name,
      { eligibilityChangedConsumer: this.eligibilityChangedConsumer.role },
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({
      getLambda: this.getLambda,
      putLambda: this.putLambda,
      eligibilityChangedConsumer: this.eligibilityChangedConsumer,
    });
  }
}
