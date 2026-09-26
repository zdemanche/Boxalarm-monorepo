import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { QueueConsumer } from "../messaging/queue-consumer";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface IncidentArgs {
  env: string;
  incidentTableName: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
  incidentCmkArn: pulumi.Input<string>;
  busName: pulumi.Input<string>;
  busArn: pulumi.Input<string>;
  nerisSchemaBucketArn: pulumi.Input<string>;
  nerisSchemaBucketName: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

const CMK_STATEMENT = (cmkArn: pulumi.Input<string>) =>
  pulumi.output(cmkArn).apply((arn) => [
    {
      Sid: "IncidentCmkAccess" as const,
      Effect: "Allow" as const,
      Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      Resource: [arn],
    },
  ]);

const SCHEMA_S3_READ_STATEMENT = (bucketArn: pulumi.Input<string>) =>
  pulumi.output(bucketArn).apply((arn) => [
    {
      Sid: "ReadNerisSchemaPins" as const,
      Effect: "Allow" as const,
      Action: ["s3:GetObject"],
      Resource: [`${arn}/neris-schema/*`],
    },
  ]);

/**
 * incident-service HTTP routes, dispatch-copy projection consumers, and their
 * scoped IAM (E6-S2-INFRA #237, E6-S4-INFRA #239, E6-S5-INFRA #240,
 * E6-S6-INFRA #241, E6-S10-INFRA #245). No incident-service Lambda here holds
 * any grant on the platform-service or alerting-service tables (issue AC).
 *
 * E6-S3-INFRA #238 (guided-completion write route) deploys VPC-less: its
 * handler (updateIncident.ts) resolves the active schema straight from
 * DynamoDB/S3, with no Valkey client in the backend to attach to — the
 * ticket's VPC + Valkey ingress scope depends on E8-S4-INFRA, which does not
 * exist in this repo yet, so there is no VPC to join.
 *
 * E6-S6-INFRA #241's Cedar exposure policy (reads/writes on INCIDENT_SECONDARY
 * narrowed to the affected member, chief, and safety officer) is not written:
 * "safety officer" is not one of the six Cedar role groups the policy store
 * provisions (authz/cedar-policies.ts ROLE_GROUPS), and the ticket's own
 * "Current state" section says that mapping decision has to be made first.
 * The route, Lambda, and table/CMK/S3 IAM below are wired regardless.
 */
export class Incident extends pulumi.ComponentResource {
  public readonly createLambda: ServiceLambda;
  public readonly updateLambda: ServiceLambda;
  public readonly narrativeLambda: ServiceLambda;
  public readonly responseTimesLambda: ServiceLambda;
  public readonly exposuresLambda: ServiceLambda;
  public readonly getLambda: ServiceLambda;
  public readonly searchLambda: ServiceLambda;
  public readonly dispatchAlertConsumer: QueueConsumer;
  public readonly dispatchResponseConsumer: QueueConsumer;

  constructor(name: string, args: IncidentArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Incident", args.env);
    super("boxalarm:incident:Incident", name, {}, opts);
    const { env } = args;

    const baseEnvironment = { INCIDENT_TABLE_NAME: args.incidentTableName };
    const cmkStatement = CMK_STATEMENT(args.incidentCmkArn);
    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "create"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              Sid: "IncidentCreateAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:PutItem",
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:UpdateItem",
              ],
              Resource: [tableArn, `${tableArn}/index/*`],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      { routeKey: "POST /api/v1/incidents", lambda: this.createLambda },
      { parent: this },
    );

    this.updateLambda = new ServiceLambda(
      `${name}-update`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-update`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "update"),
        logGroup: args.logGroup,
        environment: { ...baseEnvironment, NERIS_SCHEMA_BUCKET_NAME: args.nerisSchemaBucketName },
        additionalPolicyStatements: pulumi
          .all([
            cmkStatement,
            vpStatement,
            SCHEMA_S3_READ_STATEMENT(args.nerisSchemaBucketArn),
            args.incidentTableArn,
          ])
          .apply(([cmk, vp, s3, tableArn]) => [
            {
              // PutItem: the incident.updated OUTBOX_ENTRY committed with the update.
              Sid: "IncidentUpdateAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:GetItem",
                "dynamodb:UpdateItem",
                "dynamodb:PutItem",
                "dynamodb:Query",
              ],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
            ...s3,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-update-route`,
      { routeKey: "PUT /api/v1/incidents/{incidentId}", lambda: this.updateLambda },
      { parent: this },
    );

    this.narrativeLambda = new ServiceLambda(
      `${name}-narrative`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-narrative`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "narrative"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              // PutItem: the incident.narrative.updated OUTBOX_ENTRY committed with the update.
              Sid: "IncidentNarrativeAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-narrative-route`,
      { routeKey: "PUT /api/v1/incidents/{incidentId}/narrative", lambda: this.narrativeLambda },
      { parent: this },
    );

    this.responseTimesLambda = new ServiceLambda(
      `${name}-response-times`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-response-times`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "response-times"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              // ConditionCheckItem: parent-incident existence check inside the transaction;
              // GetItem: read-back of the committed RESPONSE# row; PutItem: the
              // incident.response_unit.updated OUTBOX_ENTRY.
              Sid: "IncidentResponseTimesAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:ConditionCheckItem",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:Query",
              ],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-response-times-route`,
      {
        routeKey: "PUT /api/v1/incidents/{incidentId}/response-times",
        lambda: this.responseTimesLambda,
      },
      { parent: this },
    );

    this.exposuresLambda = new ServiceLambda(
      `${name}-exposures`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-exposures`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "exposures"),
        logGroup: args.logGroup,
        environment: { ...baseEnvironment, NERIS_SCHEMA_BUCKET_NAME: args.nerisSchemaBucketName },
        additionalPolicyStatements: pulumi
          .all([
            cmkStatement,
            vpStatement,
            SCHEMA_S3_READ_STATEMENT(args.nerisSchemaBucketArn),
            args.incidentTableArn,
          ])
          .apply(([cmk, vp, s3, tableArn]) => [
            {
              Sid: "IncidentExposuresAccess" as const,
              Effect: "Allow" as const,
              Action: [
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:Query",
                "dynamodb:GetItem",
              ],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
            ...s3,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-exposures-route`,
      { routeKey: "PUT /api/v1/incidents/{incidentId}/exposures", lambda: this.exposuresLambda },
      { parent: this },
    );

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "get"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              Sid: "IncidentGetAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:Query"],
              Resource: [tableArn],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/incidents/{incidentId}", lambda: this.getLambda },
      { parent: this },
    );

    this.searchLambda = new ServiceLambda(
      `${name}-search`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-search`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "search"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        // No dynamodb:Scan (AC1) — searchIncidents.ts queries GSI1 only.
        additionalPolicyStatements: pulumi
          .all([cmkStatement, vpStatement, args.incidentTableArn])
          .apply(([cmk, vp, tableArn]) => [
            {
              Sid: "IncidentSearchAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [`${tableArn}/index/GSI1`],
            },
            ...cmk,
            ...vp,
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-search-route`,
      { routeKey: "GET /api/v1/incidents", lambda: this.searchLambda },
      { parent: this },
    );

    // #237: dispatch/roster projection consumers off the alerting-plane bridge
    // (dispatch.alert.received, alerting.response.confirmed republished onto
    // boxalarm-{env}-platform-bus by another story). One QueueConsumer per
    // backend handler file rather than the ticket's single named queue — both
    // are DLQ-alarmed and IAM-scoped the same as a single queue would be.
    const dispatchAlertLambda = new ServiceLambda(
      `${name}-dispatch-alert-consumer`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-dispatch-alert-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "dispatch-alert-consumer"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, args.incidentTableArn])
          .apply(([cmk, tableArn]) => [
            {
              Sid: "IncidentDispatchAlertCopyAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:PutItem"],
              Resource: [tableArn],
            },
            ...cmk,
          ]),
      },
      { parent: this },
    );
    this.dispatchAlertConsumer = new QueueConsumer(
      `${name}-dispatch-alert-consumer`,
      {
        env,
        busName: args.busName,
        busArn: args.busArn,
        ruleName: `boxalarm-${env}-incident-dispatch-alert-copy`,
        eventPattern: JSON.stringify({ "detail-type": ["dispatch.alert.received"] }),
        queueName: `boxalarm-${env}-incident-dispatch-alert-copy-queue`,
        lambda: dispatchAlertLambda.function,
        lambdaRole: dispatchAlertLambda.role,
        maxReceiveCount: 5,
        reportBatchItemFailures: true,
      },
      { parent: this },
    );

    const dispatchResponseLambda = new ServiceLambda(
      `${name}-dispatch-response-consumer`,
      {
        env,
        serviceName: "incident-service",
        functionName: `boxalarm-${env}-incident-dispatch-response-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("incident-service", "dispatch-response-consumer"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([cmkStatement, args.incidentTableArn])
          .apply(([cmk, tableArn]) => [
            {
              Sid: "IncidentDispatchRosterCopyAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:PutItem", "dynamodb:GetItem"],
              Resource: [tableArn],
            },
            ...cmk,
          ]),
      },
      { parent: this },
    );
    this.dispatchResponseConsumer = new QueueConsumer(
      `${name}-dispatch-response-consumer`,
      {
        env,
        busName: args.busName,
        busArn: args.busArn,
        ruleName: `boxalarm-${env}-incident-dispatch-response-copy`,
        eventPattern: JSON.stringify({ "detail-type": ["alerting.response.confirmed"] }),
        queueName: `boxalarm-${env}-incident-dispatch-response-copy-queue`,
        lambda: dispatchResponseLambda.function,
        lambdaRole: dispatchResponseLambda.role,
        maxReceiveCount: 5,
        reportBatchItemFailures: true,
      },
      { parent: this },
    );

    this.registerOutputs({
      createLambda: this.createLambda,
      updateLambda: this.updateLambda,
      narrativeLambda: this.narrativeLambda,
      responseTimesLambda: this.responseTimesLambda,
      exposuresLambda: this.exposuresLambda,
      getLambda: this.getLambda,
      searchLambda: this.searchLambda,
    });
  }
}
