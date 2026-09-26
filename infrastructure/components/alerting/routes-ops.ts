import * as pulumi from "@pulumi/pulumi";
import { HttpApi } from "../api/http-api";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { AlertingRoute, verifiedPermissionsStatement } from "./route-lambda";
import { grantAlertingCmk } from "./alerting-cmk";

export interface RoutesOpsArgs {
  env: string;
  httpApi: HttpApi;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  policyStoreId: pulumi.Input<string>;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

type VendorChannel = "sms" | "voice" | "push";

/**
 * Every ops route sets an explicit timeout rather than the AWS 3s default: audit and
 * delivery-baseline run two index queries plus a Verified Permissions round trip, and the
 * vendor webhooks need cold-start headroom. Well under the HTTP API's 30s integration cap.
 */
export const ROUTES_OPS_TIMEOUT_SECONDS = 10;
const VENDOR_CHANNELS: readonly VendorChannel[] = ["sms", "voice", "push"];

/**
 * Self-test, audit, and provider delivery-receipt routes (E1-S4/S8/S9/S14-INFRA-partial).
 * Vendor webhook routes carry no Cognito/Verified-Permissions authorizer — the handler
 * verifies a per-vendor shared secret itself — and each vendor Lambda can read only its
 * own webhook secret.
 */
export class RoutesOps extends pulumi.ComponentResource {
  public readonly selfTestPost: AlertingRoute;
  public readonly selfTestGet: AlertingRoute;
  public readonly audit: AlertingRoute;
  public readonly receiptsGet: AlertingRoute;
  public readonly webhooks: Record<VendorChannel, AlertingRoute>;
  public readonly canaryStatus: AlertingRoute;
  public readonly deviceReportState: AlertingRoute;
  public readonly diagnostics: AlertingRoute;
  public readonly diagnosticsSelf: AlertingRoute;
  public readonly deliveryBaseline: AlertingRoute;

  constructor(name: string, args: RoutesOpsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("RoutesOps", args.env);
    super("boxalarm:alerting:RoutesOps", name, {}, opts);
    const { env } = args;

    const vpStatement = verifiedPermissionsStatement();

    // src/services/alerting-service/selfTest/postHandler.handler
    this.selfTestPost = new AlertingRoute(
      `${name}-self-test-post`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-self-test-post`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "self-test-post"),
        routeKey: "POST /api/v1/alerting/self-test",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableSelfTestWrite",
            Effect: "Allow",
            Action: ["dynamodb:PutItem", "dynamodb:TransactWriteItems", "dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          vpStatement,
        ],
        reservedConcurrentExecutions: 3,
        timeout: ROUTES_OPS_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/selfTest/getHandler.handler
    this.selfTestGet = new AlertingRoute(
      `${name}-self-test-get`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-self-test-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "self-test-get"),
        routeKey: "GET /api/v1/alerting/self-test/{testId}",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableSelfTestRead",
            Effect: "Allow",
            Action: ["dynamodb:Query", "dynamodb:GetItem"],
            Resource: args.alertingTableArn as string,
          },
          vpStatement,
        ],
        reservedConcurrentExecutions: 3,
        timeout: ROUTES_OPS_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/audit/handler.handler
    this.audit = new AlertingRoute(
      `${name}-audit`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-audit`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "audit"),
        routeKey: "GET /api/v1/alerting/audit",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi.output(args.alertingTableArn).apply((tableArn) => [
          {
            Sid: "AlertingTableAndIndexQueryOnly",
            Effect: "Allow" as const,
            Action: ["dynamodb:Query"],
            Resource: [tableArn, `${tableArn}/index/GSI1`, `${tableArn}/index/GSI2`],
          },
          vpStatement,
        ]),
        reservedConcurrentExecutions: 3,
        timeout: ROUTES_OPS_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/receipts/getDeliveryReceiptsHandler.handler
    this.receiptsGet = new AlertingRoute(
      `${name}-receipts-get`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-receipts-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "receipts-get"),
        routeKey: "GET /api/v1/alerting/dispatches/{dispatchId}/receipts",
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
          vpStatement,
        ],
        reservedConcurrentExecutions: 3,
        timeout: ROUTES_OPS_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    const webhookRouteKeys: Record<VendorChannel, string> = {
      sms: "POST /api/v1/alerting/receipts/sms",
      voice: "POST /api/v1/alerting/receipts/voice",
      push: "POST /api/v1/alerting/receipts/push",
    };
    const webhookSecretEnvVar: Record<VendorChannel, string> = {
      sms: "SMS_PROVIDER_WEBHOOK_SECRET",
      voice: "VOICE_PROVIDER_WEBHOOK_SECRET",
      push: "PUSH_PROVIDER_WEBHOOK_SECRET",
    };
    // Real handlers:
    //  src/services/alerting-service/receipts/smsDeliveryReceiptHandler.handler
    //  src/services/alerting-service/receipts/voiceDeliveryReceiptHandler.handler
    //  src/services/alerting-service/receipts/pushReceiptHandler.handler
    //
    // These handlers compare the caller-supplied header directly against the raw
    // secretEnvVar value (no Secrets Manager lookup at send time) — see
    // receipts/vendorAuth.ts / deliveryReceiptWebhookHandler.ts — so each vendor secret
    // is a Pulumi stack secret (`pulumi config set --secret`, values set out-of-band
    // like NerisConfig's credentials), never an AWS Secrets Manager resource whose ARN
    // this Lambda would need read IAM for. Isolation (E1-S11-INFRA) is by construction:
    // each webhook Lambda's environment carries only its own channel's config key.
    const config = new pulumi.Config("boxalarm-infra");
    const webhooks: Partial<Record<VendorChannel, AlertingRoute>> = {};
    const webhookFunctionKey: Record<VendorChannel, string> = {
      sms: "sms-receipt-webhook",
      voice: "voice-receipt-webhook",
      push: "push-receipt-webhook",
    };

    for (const channel of VENDOR_CHANNELS) {
      webhooks[channel] = new AlertingRoute(
        `${name}-${channel}-webhook`,
        {
          env,
          httpApi: args.httpApi,
          logGroup: args.logGroup,
          serviceName: "alerting-service",
          functionName: `boxalarm-${env}-alerting-${channel}-receipt-webhook`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("alerting-service", webhookFunctionKey[channel]),
          routeKey: webhookRouteKeys[channel],
          authorized: false,
          environment: {
            ALERTING_TABLE_NAME: args.alertingTableName,
            [webhookSecretEnvVar[channel]]: config.requireSecret(`${channel}WebhookSecret`),
          },
          additionalPolicyStatements: [
            {
              Sid: "AlertingTableReceiptWrite",
              Effect: "Allow",
              Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
              Resource: args.alertingTableArn as string,
            },
          ],
          reservedConcurrentExecutions: 5,
          timeout: ROUTES_OPS_TIMEOUT_SECONDS,
          permissionsBoundaryArn: args.permissionsBoundaryArn,
        },
        { parent: this },
      );
    }
    this.webhooks = webhooks as Record<VendorChannel, AlertingRoute>;

    // src/services/alerting-service/canary/statusHandler.handler
    this.canaryStatus = new AlertingRoute(
      `${name}-canary-status`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-canary-status`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "canary-status"),
        routeKey: "GET /api/v1/alerting/canary/status",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableCanaryQuery",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          vpStatement,
        ],
        reservedConcurrentExecutions: 3,
        timeout: ROUTES_OPS_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/devices/reportStateHandler.handler
    this.deviceReportState = new AlertingRoute(
      `${name}-device-report-state`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-device-report-state`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "device-report-state"),
        routeKey: "POST /api/v1/alerting/devices/state",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableDeviceStateWrite",
            Effect: "Allow",
            Action: ["dynamodb:PutItem", "dynamodb:GetItem"],
            Resource: args.alertingTableArn as string,
          },
          vpStatement,
        ],
        reservedConcurrentExecutions: 5,
        timeout: ROUTES_OPS_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/diagnostics/handler.handler — "why didn't I get the
    // page" for another member (E1-S12).
    this.diagnostics = new AlertingRoute(
      `${name}-diagnostics`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-diagnostics`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "diagnostics"),
        routeKey: "GET /api/v1/alerting/dispatches/{dispatchId}/diagnostics/{memberId}",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableDiagnosticsRead",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          vpStatement,
        ],
        reservedConcurrentExecutions: 3,
        timeout: ROUTES_OPS_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/diagnostics/selfHandler.handler — own diagnosis.
    this.diagnosticsSelf = new AlertingRoute(
      `${name}-diagnostics-self`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-diagnostics-self`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "diagnostics-self"),
        routeKey: "GET /api/v1/alerting/dispatches/{dispatchId}/diagnostics",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableDiagnosticsSelfRead",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          vpStatement,
        ],
        reservedConcurrentExecutions: 3,
        timeout: ROUTES_OPS_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/audit/deliveryBaselineHandler.handler (E1-S15).
    this.deliveryBaseline = new AlertingRoute(
      `${name}-delivery-baseline`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-delivery-baseline`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("alerting-service", "delivery-baseline"),
        routeKey: "GET /api/v1/alerting/delivery-baseline",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi.output(args.alertingTableArn).apply((tableArn) => [
          {
            Sid: "AlertingTableAndIndexQueryOnly",
            Effect: "Allow" as const,
            Action: ["dynamodb:Query"],
            Resource: [tableArn, `${tableArn}/index/GSI1`, `${tableArn}/index/GSI2`],
          },
          vpStatement,
        ]),
        reservedConcurrentExecutions: 3,
        timeout: ROUTES_OPS_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    grantAlertingCmk(
      name,
      {
        selfTestPost: this.selfTestPost.lambda.role,
        selfTestGet: this.selfTestGet.lambda.role,
        audit: this.audit.lambda.role,
        receiptsGet: this.receiptsGet.lambda.role,
        ...Object.fromEntries(
          VENDOR_CHANNELS.map((channel) => [
            `${channel}Webhook`,
            this.webhooks[channel].lambda.role,
          ]),
        ),
        canaryStatus: this.canaryStatus.lambda.role,
        deviceReportState: this.deviceReportState.lambda.role,
        diagnostics: this.diagnostics.lambda.role,
        diagnosticsSelf: this.diagnosticsSelf.lambda.role,
        deliveryBaseline: this.deliveryBaseline.lambda.role,
      },
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({
      selfTestPost: this.selfTestPost,
      selfTestGet: this.selfTestGet,
      audit: this.audit,
      receiptsGet: this.receiptsGet,
      webhooks: this.webhooks,
      canaryStatus: this.canaryStatus,
      deviceReportState: this.deviceReportState,
      diagnostics: this.diagnostics,
      diagnosticsSelf: this.diagnosticsSelf,
      deliveryBaseline: this.deliveryBaseline,
    });
  }
}
