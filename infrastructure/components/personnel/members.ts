import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface MembersArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

// Per-route IAM, scoped to what each real handler (backend/src/services/personnel-service/
// members/*.ts) actually calls — not a shared read+write grant across all four routes.
// dynamodb:TransactWriteItems is not a real IAM action (DynamoDB authorizes each item in a
// transaction as its own PutItem/UpdateItem/DeleteItem call), so it was granting nothing;
// dropped everywhere below rather than carried forward as dead weight.

/** list.ts: Query on GSI3 only — read-only route, no write action of any kind. */
const LIST_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersListAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:Query"],
      Resource: [`${arn}/index/GSI3`],
    },
  ]);

/** get.ts: GetItem only — read-only route, no write action of any kind. */
const GET_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersGetAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:GetItem"],
      Resource: [arn],
    },
  ]);

/** create.ts: PutItem for the new MEMBER row plus its AUDIT_LOG_ENTRY (one TransactWriteCommand of two Puts). */
const CREATE_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersCreateAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:PutItem"],
      Resource: [arn],
    },
  ]);

/**
 * updateStatus.ts: GetItem (reads the member before validating the transition),
 * UpdateItem (the member row), PutItem (the AUDIT_LOG_ENTRY row and the OUTBOX_ENTRY
 * row, both in the same transaction — memberRepository.ts's updateMemberStatus).
 */
const UPDATE_STATUS_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "MembersUpdateStatusAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
      Resource: [arn],
    },
  ]);

/**
 * E2-S1-INFRA #203 roster routes: create/list/get/updateStatus, each its own
 * Lambda bundled from backend/src/services/personnel-service/members via
 * lambda-code.ts, scoped to the platform-service table + policy store.
 */
export class Members extends pulumi.ComponentResource {
  public readonly createLambda: ServiceLambda;
  public readonly listLambda: ServiceLambda;
  public readonly getLambda: ServiceLambda;
  public readonly updateStatusLambda: ServiceLambda;
  public readonly updateProfileLambda: ServiceLambda;

  constructor(name: string, args: MembersArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Members", args.env);
    super("boxalarm:personnel:Members", name, {}, opts);
    const { env } = args;

    // Every members Lambda is granted verifiedpermissions:IsAuthorizedWithToken (below)
    // but without this env var, readAuthzConfig() throws on every withAuthorization()
    // call — the IAM grant alone is not enough for @boxalarm/authz's client to work.
    const baseEnvironment = {
      PERSONNEL_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };
    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-create"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([CREATE_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      { routeKey: "POST /api/v1/personnel/members", lambda: this.createLambda },
      { parent: this },
    );

    this.listLambda = new ServiceLambda(
      `${name}-list`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-list`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-list"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([LIST_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-list-route`,
      { routeKey: "GET /api/v1/personnel/members", lambda: this.listLambda },
      { parent: this },
    );

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-get"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([GET_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/personnel/members/{memberId}", lambda: this.getLambda },
      { parent: this },
    );

    this.updateStatusLambda = new ServiceLambda(
      `${name}-update-status`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-update-status`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-update-status"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        // No personnel role holds any permission on the alerting-service or
        // incident-service tables (issue AC4) — statements below are scoped to
        // the platform table alone, plus the audit-key mutation deny (which now
        // allows the PutItem this route's own audit write needs — see
        // auditMutationDenyStatement's doc comment in data/platform-table.ts).
        additionalPolicyStatements: pulumi
          .all([UPDATE_STATUS_STATEMENT(args.platformTableArn), vpStatement, args.platformTableArn])
          .apply(([table, vp, tableArn]) => [
            ...table,
            ...vp,
            auditMutationDenyStatement(tableArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-update-status-route`,
      {
        routeKey: "PUT /api/v1/personnel/members/{memberId}/status",
        lambda: this.updateStatusLambda,
      },
      { parent: this },
    );

    // E2-S6-INFRA #208: member self-service profile/contact update (F2.6, AP 12). One route,
    // two Cedar actions: updateMember.ts authorizes SelfUpdateMember (every role, via the
    // self-service policy) when the path memberId is the caller's own sub — and re-checks
    // memberId === principal.sub before writing — and UpdateMember (ADMIN_ONLY_ACTIONS,
    // CHIEF/ADMIN) for anyone else's profile.
    this.updateProfileLambda = new ServiceLambda(
      `${name}-update-profile`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-members-update-profile`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "members-update-profile"),
        logGroup: args.logGroup,
        // updateMember.ts reads PLATFORM_TABLE_NAME (config.ts readMemberServiceConfig),
        // not PERSONNEL_TABLE_NAME like the other members routes.
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        // UpdateItem (member row) + PutItem (outbox row), one transaction; plus the
        // audit-key mutation deny every table-wide UpdateItem holder carries (F9.4).
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, vpStatement])
          .apply(([tableArn, vp]) => [
            {
              Sid: "MembersUpdateProfileAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:UpdateItem", "dynamodb:PutItem"],
              Resource: [tableArn],
            },
            ...vp,
            auditMutationDenyStatement(tableArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-update-profile-route`,
      { routeKey: "PUT /api/v1/personnel/members/{memberId}", lambda: this.updateProfileLambda },
      { parent: this },
    );

    this.registerOutputs({
      createLambda: this.createLambda,
      listLambda: this.listLambda,
      getLambda: this.getLambda,
      updateStatusLambda: this.updateStatusLambda,
      updateProfileLambda: this.updateProfileLambda,
    });
  }
}
