import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:apigatewayv2/api:Api") {
        state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("Certifications — certExpiredReactor stream consumer (#221)", () => {
  async function build() {
    const { Certifications } = await import("../../components/training/certifications");
    const logGroup = new ServiceLogGroup("test-certifications-log-group", {
      env: "dev",
      serviceName: "training-service",
    });
    const httpApi = new HttpApi("test-certifications-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Certifications("test-certifications", {
      env: "dev",
      deptId: "nichols-fd",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      platformBusName: pulumi.output("boxalarm-dev-platform-bus"),
      platformBusArn: pulumi.output(
        "arn:aws:events:us-east-1:123456789012:event-bus/boxalarm-dev-platform-bus",
      ),
      platformTableStreamArn: pulumi.output(
        "arn:aws:dynamodb:us-east-1:123456789012:table/platform/stream/2026-01-01T00:00:00.000",
      ),
      logGroup,
      httpApi,
    });
  }

  it("filters the stream mapping to entityType=CERTIFICATION at the ESM (never in code)", async () => {
    const certifications = await build();
    const filterCriteria = await resolve(
      certifications.certExpiredReactorEventSourceMapping.filterCriteria,
    );
    const pattern = JSON.parse(filterCriteria!.filters![0]!.pattern!) as {
      dynamodb: { NewImage: { entityType: { S: string[] } } };
    };
    expect(pattern.dynamodb.NewImage.entityType.S).toEqual(["CERTIFICATION"]);
  });

  it("reports partial batch failures so only the failing record redrives", async () => {
    const certifications = await build();
    const responseTypes = await resolve(
      certifications.certExpiredReactorEventSourceMapping.functionResponseTypes,
    );
    expect(responseTypes).toEqual(["ReportBatchItemFailures"]);
  });

  it("routes a persistent failure to the onFailure destination queue with an alarm", async () => {
    const certifications = await build();
    const [destinationConfig, threshold, comparison] = await Promise.all([
      resolve(certifications.certExpiredReactorEventSourceMapping.destinationConfig),
      resolve(certifications.certExpiredReactorOnFailureAlarm.threshold),
      resolve(certifications.certExpiredReactorOnFailureAlarm.comparisonOperator),
    ]);
    expect(destinationConfig?.onFailure?.destinationArn).toBeDefined();
    expect(threshold).toBe(0);
    expect(comparison).toBe("GreaterThanThreshold");
  });

  it("grants the reactor sqs:SendMessage on its on-failure queue so exhausted records reach it", async () => {
    const certifications = await build();
    const [policyJson, queueArn] = await Promise.all([
      resolve(certifications.certExpiredReactorStreamPolicy.policy),
      resolve(certifications.certExpiredReactorOnFailureQueue.arn),
    ]);
    const policy = JSON.parse(policyJson) as {
      Statement: Array<{ Sid: string; Action: string[]; Resource: string }>;
    };
    const statement = policy.Statement.find((s) => s.Sid === "SendToOnFailureQueue");
    expect(statement?.Action).toEqual(["sqs:SendMessage"]);
    expect(statement?.Resource).toBe(queueArn);
  });

  it("alarms on the EligibilityFlipFailed metric under the exact namespace the reactor emits", async () => {
    const certifications = await build();
    const [namespace, metricName] = await Promise.all([
      resolve(certifications.eligibilityFlipFailedAlarm.namespace),
      resolve(certifications.eligibilityFlipFailedAlarm.metricName),
    ]);
    expect(namespace).toBe("Boxalarm/personnel-service");
    expect(metricName).toBe("EligibilityFlipFailed");
  });

  it("grants the reactor and scanner roles no permission on the alerting table (AC4)", async () => {
    const certifications = await build();
    const [reactorPolicy, scannerPolicy] = await Promise.all([
      resolve(certifications.certExpiredReactorLambda.rolePolicy.policy),
      resolve(certifications.scannerLambda.rolePolicy.policy),
    ]);
    expect(reactorPolicy).not.toContain("table/alerting");
    expect(scannerPolicy).not.toContain("table/alerting");
  });

  it("grants the reactor role Query plus the item-level writes its transaction needs", async () => {
    const certifications = await build();
    const policyJson = await resolve(certifications.certExpiredReactorLambda.rolePolicy.policy);
    const policy = JSON.parse(policyJson) as {
      Statement: Array<{ Sid: string; Action: string[] }>;
    };
    const statement = policy.Statement.find((s) => s.Sid === "CertExpiredReactorAccess");
    // IAM authorizes transaction items as UpdateItem/PutItem; TransactWriteItems is not
    // an IAM action and must not be relied on.
    expect(statement?.Action).toEqual([
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "dynamodb:PutItem",
    ]);
  });
});
