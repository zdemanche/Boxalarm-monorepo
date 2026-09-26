import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import {
  ALERT_PATH_MEMORY_MB,
  ALERTING_CHANNELS,
  AlertingChannel,
  ChannelQueue,
  DEFAULT_WORKER_TIMEOUT_SECONDS,
} from "./messaging-alerting";
import { grantAlertingCmk } from "./alerting-cmk";

// OQ-3 (SMS/voice vendor selection) is open — placeholder endpoints until a vendor is
// chosen. Values are read verbatim by channels/httpProviderAdapter.ts at send time, which
// POSTs the member's target, the dispatch narrative and the Bearer provider secret. The
// placeholders therefore use the RFC 2606 reserved `.invalid` TLD, which can never resolve,
// so nothing is ever sent to a domain the project does not control.
const PLACEHOLDER_ENDPOINT_URL: Record<AlertingChannel, string> = {
  push: "https://push-provider.not-yet-selected.invalid",
  sms: "https://sms-provider.not-yet-selected.invalid",
  voice: "https://voice-provider.not-yet-selected.invalid",
};

/**
 * Reserved concurrency per channel worker. The SQS event source mapping's
 * maximumConcurrency is pinned to the same value: when pollers outrun reserved concurrency
 * the invocations are throttled, and each throttled receive counts toward maxReceiveCount,
 * pushing pages to the DLQ early.
 */
export const WORKER_RESERVED_CONCURRENCY = 5;

export interface ChannelWorkersArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  channelQueues: Record<AlertingChannel, ChannelQueue>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
  /** Must match the value MessagingAlerting sized the queue visibility timeout from. */
  workerTimeoutSeconds?: number;
}

/**
 * Push/SMS/voice channel worker Lambdas (E1-S2/S3-INFRA). Each has its own queue, DLQ,
 * reserved concurrency and provider secret — no worker can read another channel's queue
 * or secret (E1-S11-INFRA isolation). Self-test sandbox secrets (E1-S8-INFRA) are
 * provisioned alongside and passed as `{CH}_PROVIDER_SANDBOX_SECRET_ID`; the worker
 * selects them for `isTest` messages (channels/httpProviderAdapter.ts).
 */
export class ChannelWorkers extends pulumi.ComponentResource {
  public readonly workers: Record<AlertingChannel, ServiceLambda>;
  public readonly providerSecrets: Record<AlertingChannel, aws.secretsmanager.Secret>;
  public readonly sandboxSecrets: Record<AlertingChannel, aws.secretsmanager.Secret>;

  constructor(name: string, args: ChannelWorkersArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("ChannelWorkers", args.env);
    super("boxalarm:alerting:ChannelWorkers", name, {}, opts);
    const { env } = args;

    const workers: Partial<Record<AlertingChannel, ServiceLambda>> = {};
    const providerSecrets: Partial<Record<AlertingChannel, aws.secretsmanager.Secret>> = {};
    const sandboxSecrets: Partial<Record<AlertingChannel, aws.secretsmanager.Secret>> = {};

    for (const channel of ALERTING_CHANNELS) {
      const providerSecret = new aws.secretsmanager.Secret(
        `${name}-${channel}-secret`,
        {
          name: `boxalarm-${env}-alerting-${channel}-provider-credentials`,
          description: `${channel} provider credentials (values set out-of-band)`,
        },
        { parent: this },
      );
      const sandboxSecret = new aws.secretsmanager.Secret(
        `${name}-${channel}-sandbox-secret`,
        {
          name: `boxalarm-${env}-alerting-${channel}-provider-sandbox-credentials`,
          description: `${channel} provider sandbox/loopback credentials for self-test (E1-S8)`,
        },
        { parent: this },
      );
      providerSecrets[channel] = providerSecret;
      sandboxSecrets[channel] = sandboxSecret;

      const channelUpper = channel.toUpperCase();
      const queue = args.channelQueues[channel].queue;

      const worker = new ServiceLambda(
        `${name}-${channel}-fn`,
        {
          env,
          serviceName: "alerting-service",
          functionName: `boxalarm-${env}-alerting-${channel}-worker`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("alerting-service", `${channel}-worker`),
          logGroup: args.logGroup,
          environment: {
            ALERTING_TABLE_NAME: args.alertingTableName,
            [`${channelUpper}_PROVIDER_ENDPOINT_URL`]: PLACEHOLDER_ENDPOINT_URL[channel],
            [`${channelUpper}_PROVIDER_SECRET_ID`]: providerSecret.name,
            // Self-test and canary messages (isTest=true) must authenticate with the
            // sandbox/loopback credentials, never the prod ones (architecture §1.3).
            [`${channelUpper}_PROVIDER_SANDBOX_SECRET_ID`]: sandboxSecret.name,
          },
          additionalPolicyStatements: pulumi
            .all([providerSecret.arn, sandboxSecret.arn, queue.arn])
            .apply(([prodArn, sandboxArn, queueArn]) => [
              {
                // The SQS event source mapping polls as this role; without these,
                // CreateEventSourceMapping is rejected and the channel never drains.
                Sid: "ConsumeOwnChannelQueueOnly",
                Effect: "Allow" as const,
                Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
                Resource: queueArn,
              },
              {
                Sid: "AlertingTableWrite",
                Effect: "Allow" as const,
                Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"],
                Resource: args.alertingTableArn as string,
              },
              {
                Sid: "OwnProviderSecretOnly",
                Effect: "Allow" as const,
                Action: ["secretsmanager:GetSecretValue"],
                Resource: [prodArn, sandboxArn],
              },
            ]),
          reservedConcurrentExecutions: WORKER_RESERVED_CONCURRENCY,
          timeout: args.workerTimeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS,
          memorySize: ALERT_PATH_MEMORY_MB,
          permissionsBoundaryArn: args.permissionsBoundaryArn,
        },
        { parent: this },
      );

      new aws.lambda.EventSourceMapping(
        `${name}-${channel}-event-source`,
        {
          eventSourceArn: queue.arn,
          functionName: worker.function.name,
          functionResponseTypes: ["ReportBatchItemFailures"],
          scalingConfig: { maximumConcurrency: WORKER_RESERVED_CONCURRENCY },
        },
        { parent: this },
      );

      workers[channel] = worker;
    }

    this.workers = workers as Record<AlertingChannel, ServiceLambda>;
    this.providerSecrets = providerSecrets as Record<AlertingChannel, aws.secretsmanager.Secret>;
    this.sandboxSecrets = sandboxSecrets as Record<AlertingChannel, aws.secretsmanager.Secret>;

    grantAlertingCmk(
      name,
      Object.fromEntries(ALERTING_CHANNELS.map((channel) => [channel, this.workers[channel].role])),
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({ workers: this.workers });
  }
}
