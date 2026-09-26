import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface CertificationsArgs {
  env: string;
  deptId: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  platformBusName: pulumi.Input<string>;
  platformBusArn: pulumi.Input<string>;
  platformTableStreamArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E3-S1/S2/S8-INFRA (#214, #215, #221): certification records, plus the daily expiry scanner.
 *
 * #221 chain (expiry -> alerting eligibility), end to end:
 *   1. The daily scanner (certificationExpiryScanner/handler.ts) writes status=EXPIRED on
 *      every CURRENT certification past its expiryDate (certifications/expiryScan.ts's
 *      flipExpiredCertifications, conditional on CURRENT, with an audit row). It also
 *      publishes the lead-time cert.expiry.due notification — that event is a reminder
 *      only; nothing consumes it for eligibility.
 *   2. That status write reaches events/certExpiredReactor.ts through a DynamoDB Streams
 *      mapping on the platform table, filtered to entityType=CERTIFICATION — a second,
 *      independent stream mapping alongside the shared OutboxPublisher's OUTBOX_ENTRY one.
 *      A manual revoke (status=REVOKED) takes the same path.
 *   3. The reactor sets MEMBER_QUALIFICATION.currentlyEligible=false and writes a
 *      personnel.eligibility.changed outbox row, which the OutboxPublisher delivers to the
 *      alerting eligibility snapshot (quals.ts's eligibility-changed consumer).
 * Training records share the platform table (no dedicated training table exists) — both
 * TRAINING_TABLE_NAME (client.ts) and TRAINING_DYNAMO_TABLE_NAME (dynamoClient.ts) point
 * at it, and PLATFORM_CONFIG_DYNAMO_TABLE_NAME (per-dept CONFIG#ALERT_RULES lead-time) too.
 *
 * NOT wired here: attachmentUpload.ts's CloudFront signed-URL upload path
 * (CLOUDFRONT_DISTRIBUTION_DOMAIN / _KEY_PAIR_ID / _PRIVATE_KEY_SECRET_ID). CloudFront is a
 * global-edge service and residency-encryption.test.ts enforces N6.1 (U.S.-only, no global
 * edge) repo-wide — provisioning it here would fail that gate. createCertification without
 * an attachmentFilename works; a request that includes one reaches
 * readAttachmentUploadConfig() and fails closed with a 503, since none of those three env
 * vars are set. Fixing this needs a region-pinned replacement (e.g. S3 presigned PutObject)
 * in attachmentUpload.ts itself — backend work outside this infra ticket's footprint.
 */
export class Certifications extends pulumi.ComponentResource {
  public readonly createLambda: ServiceLambda;
  public readonly listLambda: ServiceLambda;
  public readonly revokeLambda: ServiceLambda;
  public readonly expiringLambda: ServiceLambda;
  public readonly scannerLambda: ServiceLambda;
  public readonly scannerSchedule: aws.scheduler.Schedule;
  public readonly scannerDlq: aws.sqs.Queue;
  public readonly scannerDlqAlarm: aws.cloudwatch.MetricAlarm;
  public readonly scannerErrorsAlarm: aws.cloudwatch.MetricAlarm;
  public readonly certExpiredReactorLambda: ServiceLambda;
  public readonly certExpiredReactorOnFailureQueue: aws.sqs.Queue;
  public readonly certExpiredReactorStreamPolicy: aws.iam.RolePolicy;
  public readonly certExpiredReactorEventSourceMapping: aws.lambda.EventSourceMapping;
  public readonly certExpiredReactorOnFailureAlarm: aws.cloudwatch.MetricAlarm;
  public readonly eligibilityFlipFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: CertificationsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Certifications", args.env);
    super("boxalarm:training:Certifications", name, {}, opts);
    const { env } = args;

    const baseEnvironment = {
      TRAINING_TABLE_NAME: args.platformTableName,
      TRAINING_DYNAMO_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };
    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);
    // Per-Lambda least privilege, scoped to what each handler actually calls.
    // create.ts: createCertification is one transaction of two Puts (cert + audit row).
    const createStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "CertificationsCreateAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:PutItem"],
        Resource: [arn],
      },
    ]);
    // list.ts: listCertificationsForMember is a base-table Query.
    const listStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "CertificationsListAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:Query"],
        Resource: [arn],
      },
    ]);
    // revoke.ts: GetItem (current status), then one transaction of Update (cert) + Put (audit).
    const revokeStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "CertificationsRevokeAccess" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
        Resource: [arn],
      },
      auditMutationDenyStatement(arn),
    ]);

    this.createLambda = new ServiceLambda(
      `${name}-create`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-certifications-create`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certifications-create"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([createStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-create-route`,
      {
        routeKey: "POST /api/v1/training/members/{memberId}/certifications",
        lambda: this.createLambda,
      },
      { parent: this },
    );

    this.listLambda = new ServiceLambda(
      `${name}-list`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-certifications-list`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certifications-list"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([listStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-list-route`,
      {
        routeKey: "GET /api/v1/training/members/{memberId}/certifications",
        lambda: this.listLambda,
      },
      { parent: this },
    );

    this.revokeLambda = new ServiceLambda(
      `${name}-revoke`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-certifications-revoke`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certifications-revoke"),
        logGroup: args.logGroup,
        environment: baseEnvironment,
        additionalPolicyStatements: pulumi
          .all([revokeStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-revoke-route`,
      {
        routeKey: "POST /api/v1/training/members/{memberId}/certifications/{certId}/revoke",
        lambda: this.revokeLambda,
      },
      { parent: this },
    );

    // expiring.ts: readCertExpiryLeadDays GetItems CONFIG#ALERT_RULES from the base table;
    // queryCertificationsDueInMonth Queries GSI2 (AP 13) — IAM needs the index ARN for that.
    const expiringStatement = pulumi.output(args.platformTableArn).apply((arn) => [
      {
        Sid: "CertificationsExpiringConfigRead" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:GetItem"],
        Resource: [arn],
      },
      {
        Sid: "CertificationsExpiringDueQuery" as const,
        Effect: "Allow" as const,
        Action: ["dynamodb:Query"],
        Resource: [`${arn}/index/GSI2`],
      },
    ]);

    this.expiringLambda = new ServiceLambda(
      `${name}-expiring`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-certifications-expiring`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certifications-expiring"),
        logGroup: args.logGroup,
        environment: {
          ...baseEnvironment,
          PLATFORM_CONFIG_DYNAMO_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: pulumi
          .all([expiringStatement, vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-expiring-route`,
      { routeKey: "GET /api/v1/training/certifications/expiring", lambda: this.expiringLambda },
      { parent: this },
    );

    this.scannerLambda = new ServiceLambda(
      `${name}-scanner`,
      {
        env,
        serviceName: "training-service",
        functionName: `boxalarm-${env}-training-cert-expiry-scanner`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("training-service", "certification-expiry-scanner"),
        logGroup: args.logGroup,
        environment: {
          TRAINING_DYNAMO_TABLE_NAME: args.platformTableName,
          PLATFORM_CONFIG_DYNAMO_TABLE_NAME: args.platformTableName,
          PLATFORM_EVENT_BUS_NAME: args.platformBusName,
          TRAINING_SCANNER_DEPT_ID: args.deptId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.platformBusArn])
          .apply(([tableArn, busArn]) => [
            {
              // GetItem: readCertExpiryLeadDays (CONFIG#ALERT_RULES). PutItem/UpdateItem:
              // publishDueEvent's CERT_EXPIRY_FLAG dedup marker, and the EXPIRED flip's
              // transaction (Update on the cert row + Put of its audit row).
              Sid: "CertExpiryScannerTableAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
              Resource: [tableArn],
            },
            {
              // queryCertificationsDueInMonth: GSI2 (AP 13).
              Sid: "CertExpiryScannerDueQuery" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [`${tableArn}/index/GSI2`],
            },
            {
              Sid: "CertExpiryScannerPublish" as const,
              Effect: "Allow" as const,
              Action: ["events:PutEvents"],
              Resource: busArn,
            },
            auditMutationDenyStatement(tableArn),
          ]),
      },
      { parent: this },
    );

    // Mirrors shifts.ts's completion schedule: retry, DLQ + depth alarm, and an Errors alarm,
    // so a failing daily run (AccessDenied, throttle, or an unflipped expired cert — the
    // handler fails the invocation for those) never goes unnoticed.
    this.scannerDlq = new aws.sqs.Queue(
      `${name}-scanner-dlq`,
      { name: `boxalarm-${env}-training-cert-expiry-scanner-dlq` },
      { parent: this },
    );

    this.scannerDlqAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-scanner-dlq-depth-alarm`,
      {
        name: `boxalarm-${env}-training-cert-expiry-scanner-dlq-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.scannerDlq.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.scannerErrorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-scanner-errors-alarm`,
      {
        name: `boxalarm-${env}-training-cert-expiry-scanner-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.scannerLambda.function.name },
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    const schedulerRole = new aws.iam.Role(
      `${name}-scanner-scheduler-role`,
      {
        name: `boxalarm-${env}-training-cert-expiry-scheduler`,
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
      `${name}-scanner-scheduler-role-policy`,
      {
        role: schedulerRole.id,
        policy: pulumi
          .all([this.scannerLambda.function.arn, this.scannerDlq.arn])
          .apply(([lambdaArn, dlqArn]) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "InvokeCertExpiryScanner",
                  Effect: "Allow",
                  Action: "lambda:InvokeFunction",
                  Resource: lambdaArn,
                },
                {
                  Sid: "CertExpirySchedulerDlq",
                  Effect: "Allow",
                  Action: "sqs:SendMessage",
                  Resource: dlqArn,
                },
              ],
            }),
          ),
      },
      { parent: this },
    );

    this.scannerSchedule = new aws.scheduler.Schedule(
      `${name}-scanner-schedule`,
      {
        name: `boxalarm-${env}-training-cert-expiry-scanner-daily`,
        scheduleExpression: "rate(1 day)",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: this.scannerLambda.function.arn,
          roleArn: schedulerRole.arn,
          retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 3600 },
          deadLetterConfig: { arn: this.scannerDlq.arn },
        },
      },
      { parent: this },
    );

    // #114/#204/#221: platform-table stream -> certExpiredReactor.ts, filtered to
    // entityType=CERTIFICATION at the EventSourceMapping (not in code) so no other
    // entityType invokes this Lambda. readPersonnelServiceConfig (awsClients.ts) requires
    // both PERSONNEL_TABLE_NAME and PLATFORM_BUS_NAME, even though this reactor only writes
    // to the table itself — flipEligibilityOnCertExpired publishes via the same OUTBOX_ENTRY
    // shape the already-deployed shared OutboxPublisher consumes, so no events:PutEvents grant.
    this.certExpiredReactorLambda = new ServiceLambda(
      `${name}-cert-expired-reactor`,
      {
        env,
        serviceName: "personnel-service",
        functionName: `boxalarm-${env}-personnel-cert-expired-reactor`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("personnel-service", "cert-expired-reactor"),
        logGroup: args.logGroup,
        environment: {
          PERSONNEL_TABLE_NAME: args.platformTableName,
          PLATFORM_BUS_NAME: args.platformBusName,
        },
        additionalPolicyStatements: pulumi.output(args.platformTableArn).apply((tableArn) => [
          {
            // flipEligibilityOnCertExpired: Query (held quals), then one transaction of
            // Update (QUAL row) + Put (OUTBOX row) items. IAM authorizes each transaction
            // item as its own UpdateItem/PutItem — dynamodb:TransactWriteItems is not an
            // IAM action and grants nothing.
            Sid: "CertExpiredReactorAccess" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:PutItem"],
            Resource: [tableArn],
          },
          auditMutationDenyStatement(tableArn),
        ]),
      },
      { parent: this },
    );

    this.certExpiredReactorOnFailureQueue = new aws.sqs.Queue(
      `${name}-cert-expired-reactor-onfailure`,
      { name: `boxalarm-${env}-cert-expired-reactor-onfailure` },
      { parent: this },
    );

    this.certExpiredReactorEventSourceMapping = new aws.lambda.EventSourceMapping(
      `${name}-cert-expired-reactor-esm`,
      {
        eventSourceArn: args.platformTableStreamArn,
        functionName: this.certExpiredReactorLambda.function.name,
        startingPosition: "LATEST",
        batchSize: 10,
        bisectBatchOnFunctionError: true,
        maximumRetryAttempts: 5,
        maximumRecordAgeInSeconds: 3600,
        functionResponseTypes: ["ReportBatchItemFailures"],
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                dynamodb: { NewImage: { entityType: { S: ["CERTIFICATION"] } } },
              }),
            },
          ],
        },
        destinationConfig: {
          onFailure: { destinationArn: this.certExpiredReactorOnFailureQueue.arn },
        },
      },
      { parent: this },
    );

    this.certExpiredReactorStreamPolicy = new aws.iam.RolePolicy(
      `${name}-cert-expired-reactor-stream-read-policy`,
      {
        role: this.certExpiredReactorLambda.role.id,
        policy: pulumi
          .all([args.platformTableStreamArn, this.certExpiredReactorOnFailureQueue.arn])
          .apply(([streamArn, onFailureQueueArn]) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "ReadPlatformTableStream",
                  Effect: "Allow",
                  Action: [
                    "dynamodb:GetRecords",
                    "dynamodb:GetShardIterator",
                    "dynamodb:DescribeStream",
                    "dynamodb:ListStreams",
                  ],
                  Resource: streamArn,
                },
                {
                  // The on-failure destination is written with this execution role;
                  // without it, exhausted records are dropped instead of queued.
                  Sid: "SendToOnFailureQueue",
                  Effect: "Allow",
                  Action: ["sqs:SendMessage"],
                  Resource: onFailureQueueArn,
                },
              ],
            }),
          ),
      },
      { parent: this },
    );

    this.certExpiredReactorOnFailureAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-cert-expired-reactor-onfailure-alarm`,
      {
        name: `boxalarm-${env}-cert-expired-reactor-onfailure-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.certExpiredReactorOnFailureQueue.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.eligibilityFlipFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-eligibility-flip-failed-alarm`,
      {
        name: `boxalarm-${env}-training-eligibility-flip-failed`,
        namespace: "Boxalarm/personnel-service",
        metricName: "EligibilityFlipFailed",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    this.registerOutputs({
      createLambda: this.createLambda,
      listLambda: this.listLambda,
      revokeLambda: this.revokeLambda,
      expiringLambda: this.expiringLambda,
      scannerLambda: this.scannerLambda,
      certExpiredReactorLambda: this.certExpiredReactorLambda,
    });
  }
}
