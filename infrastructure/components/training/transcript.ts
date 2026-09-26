import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface TranscriptArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E3-S7-INFRA #220: exportable per-member training transcript (json/csv/pdf). get.ts reads
 * both TRAINING_TABLE_NAME (client.ts) and TRAINING_DYNAMO_TABLE_NAME (dynamoClient.ts) —
 * the same physical platform table.
 */
export class Transcript extends pulumi.ComponentResource {
  public readonly getLambda: ServiceLambda;

  constructor(name: string, args: TranscriptArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Transcript", args.env);
    super("boxalarm:training:Transcript", name, {}, opts);
    const { env } = args;

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-transcript-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "transcript-get"),
        logGroup: args.logGroup,
        environment: {
          TRAINING_TABLE_NAME: args.platformTableName,
          TRAINING_DYNAMO_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              // listCertificationsForMember (base table) + listMemberAttendanceRecords
              // (GSI1, AP 25). No GetItem call exists on this path.
              Sid: "TranscriptReadAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [tableArn, `${tableArn}/index/GSI1`],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      {
        routeKey: "GET /api/v1/training/members/{memberId}/transcript",
        lambda: this.getLambda,
      },
      { parent: this },
    );

    this.registerOutputs({ getLambda: this.getLambda });
  }
}
