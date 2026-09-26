import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface HoursArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/** E3-S5-INFRA #218: training hours by member/category/period, Cedar-gated (ViewTrainingHours/ViewRosterTrainingHours). */
export class Hours extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;

  constructor(name: string, args: HoursArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Hours", args.env);
    super("boxalarm:training:Hours", name, {}, opts);
    const { env } = args;

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-hours`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "hours"),
        logGroup: args.logGroup,
        environment: {
          TRAINING_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              // Member path: listMemberAttendanceInRange (GSI1). Roster path:
              // listTrainingEventsInRange (GSI3), then listEventAttendees (base table).
              Sid: "TrainingHoursReadAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [tableArn, `${tableArn}/index/GSI1`, `${tableArn}/index/GSI3`],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-route`,
      { routeKey: "GET /api/v1/training/hours", lambda: this.lambda },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda });
  }
}
