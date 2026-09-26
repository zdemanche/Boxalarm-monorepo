import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface ReportsArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/** E3-S6-INFRA #219: ISO-aligned training hour reporting (ViewIsoTrainingReport, officer-tier). */
export class Reports extends pulumi.ComponentResource {
  public readonly isoLambda: ServiceLambda;

  constructor(name: string, args: ReportsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Reports", args.env);
    super("boxalarm:training:Reports", name, {}, opts);
    const { env } = args;

    this.isoLambda = new ServiceLambda(
      `${name}-iso`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-reports-iso`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "reports-iso"),
        logGroup: args.logGroup,
        environment: {
          TRAINING_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              // listAttendanceForPeriod: listTrainingEventsInRange (GSI3, AP 26), then
              // listEventAttendees per event (base table).
              Sid: "IsoReportReadAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [tableArn, `${tableArn}/index/GSI3`],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-iso-route`,
      { routeKey: "GET /api/v1/training/reports/iso", lambda: this.isoLambda },
      { parent: this },
    );

    this.registerOutputs({ isoLambda: this.isoLambda });
  }
}
