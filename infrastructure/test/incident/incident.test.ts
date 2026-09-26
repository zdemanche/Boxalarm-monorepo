import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";

const TABLE_ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-incident-service";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
        state.invokeArn = `${state.arn}-invoke`;
      }
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.inputs.name ?? args.name}`;
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

interface PolicyDoc {
  Statement: Array<{ Sid: string; Action: string[]; Resource: string | string[] }>;
}

describe("Incident", () => {
  async function build() {
    const { Incident } = await import("../../components/incident/incident");
    const logGroup = new ServiceLogGroup("test-incident-log-group", {
      env: "dev",
      serviceName: "incident-service",
    });
    const httpApi = new HttpApi("test-incident-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Incident("test-incident", {
      env: "dev",
      incidentTableName: pulumi.output("boxalarm-dev-incident-service"),
      incidentTableArn: pulumi.output(TABLE_ARN),
      incidentCmkArn: pulumi.output("arn:aws:kms:us-east-1:123456789012:key/incident-cmk"),
      busName: pulumi.output("boxalarm-dev-platform-bus"),
      busArn: pulumi.output(
        "arn:aws:events:us-east-1:123456789012:event-bus/boxalarm-dev-platform-bus",
      ),
      nerisSchemaBucketArn: pulumi.output("arn:aws:s3:::neris-schema"),
      nerisSchemaBucketName: pulumi.output("neris-schema"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      logGroup,
      httpApi,
    });
  }

  async function actionsFor(
    lambda: { rolePolicy: { policy: pulumi.Output<string> } },
    sid: string,
  ): Promise<string[]> {
    const policy = JSON.parse(await resolve(lambda.rolePolicy.policy)) as PolicyDoc;
    return policy.Statement.find((s) => s.Sid === sid)?.Action ?? [];
  }

  it("lets every mutation Lambda Put its OUTBOX_ENTRY in the same transaction as the entity write", async () => {
    const incident = await build();
    expect(await actionsFor(incident.updateLambda, "IncidentUpdateAccess")).toContain(
      "dynamodb:PutItem",
    );
    expect(await actionsFor(incident.narrativeLambda, "IncidentNarrativeAccess")).toContain(
      "dynamodb:PutItem",
    );
    expect(await actionsFor(incident.exposuresLambda, "IncidentExposuresAccess")).toContain(
      "dynamodb:PutItem",
    );
    expect(await actionsFor(incident.responseTimesLambda, "IncidentResponseTimesAccess")).toEqual(
      expect.arrayContaining(["dynamodb:PutItem", "dynamodb:UpdateItem"]),
    );
  });

  it("grants response-times the transactional parent-exists ConditionCheck and the read-back GetItem", async () => {
    const incident = await build();
    expect(await actionsFor(incident.responseTimesLambda, "IncidentResponseTimesAccess")).toEqual(
      expect.arrayContaining(["dynamodb:ConditionCheckItem", "dynamodb:GetItem"]),
    );
  });

  it("opts both dispatch-copy consumers into ReportBatchItemFailures (their handlers return batchItemFailures)", async () => {
    const incident = await build();
    const [alert, response] = await Promise.all([
      resolve(incident.dispatchAlertConsumer.eventSourceMapping.functionResponseTypes),
      resolve(incident.dispatchResponseConsumer.eventSourceMapping.functionResponseTypes),
    ]);
    expect(alert).toEqual(["ReportBatchItemFailures"]);
    expect(response).toEqual(["ReportBatchItemFailures"]);
  });
});
