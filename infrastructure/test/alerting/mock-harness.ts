import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { Escalation } from "../../components/alerting/escalation";
import { FanOut } from "../../components/alerting/fan-out";
import { RoutesCore } from "../../components/alerting/routes-core";

/**
 * Shared Pulumi-mock harness for the alerting-chain tests: records every mocked
 * resource so a test can assert on the *resolved* IAM statements, event source
 * mappings, Lambda settings, and alarms a component actually emits.
 */

export const ACCOUNT_ID = "123456789012";
export const REGION = "us-east-1";

export interface MockedResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

export interface PolicyStatement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export let resources: MockedResource[] = [];

export function installMocks(config: Record<string, string> = {}): void {
  resources = [];
  pulumi.runtime.setMocks(
    {
      newResource: (args: pulumi.runtime.MockResourceArgs) => {
        resources.push({ type: args.type, name: args.name, inputs: args.inputs });
        const state: Record<string, unknown> = { ...args.inputs };
        const physical = (args.inputs.name as string | undefined) ?? args.name;
        switch (args.type) {
          case "aws:iam/role:Role":
            state.arn = `arn:aws:iam::${ACCOUNT_ID}:role/${physical}`;
            break;
          case "aws:lambda/function:Function":
            state.arn = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${physical}`;
            state.invokeArn = `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${state.arn as string}/invocations`;
            break;
          case "aws:sqs/queue:Queue":
            state.arn = `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${physical}`;
            state.url = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/${physical}`;
            break;
          case "aws:sns/topic:Topic":
            state.arn = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:${physical}`;
            break;
          case "aws:cloudwatch/logGroup:LogGroup":
            state.arn = `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${physical}`;
            break;
          case "aws:secretsmanager/secret:Secret":
            state.arn = `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${physical}`;
            break;
          case "aws:dynamodb/table:Table":
            state.arn = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${physical}`;
            state.streamArn = `${state.arn as string}/stream/2026-01-01T00:00:00.000`;
            break;
          case "aws:kms/key:Key":
            state.arn = `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/${args.name}`;
            break;
          case "aws:iam/policy:Policy":
            state.arn = `arn:aws:iam::${ACCOUNT_ID}:policy/${physical}`;
            break;
          case "aws:cloudwatch/eventBus:EventBus":
            state.arn = `arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/${physical}`;
            break;
          case "aws:cloudwatch/eventRule:EventRule":
            state.arn = `arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${physical}`;
            break;
          case "aws:scheduler/scheduleGroup:ScheduleGroup":
            state.arn = `arn:aws:scheduler:${REGION}:${ACCOUNT_ID}:schedule-group/${physical}`;
            break;
          case "aws:s3/bucket:Bucket":
            state.arn = `arn:aws:s3:::${(args.inputs.bucket as string | undefined) ?? args.name}`;
            state.bucket = args.inputs.bucket ?? args.name;
            break;
          case "aws:cognito/userPool:UserPool":
            state.arn = `arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/${args.name}`;
            break;
          case "aws:verifiedpermissions/policyStore:PolicyStore":
            state.policyStoreId = `${args.name}-id`;
            state.arn = `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/${args.name}-id`;
            break;
          case "aws:apigatewayv2/api:Api":
            state.apiEndpoint = `https://${args.name}.execute-api.${REGION}.amazonaws.com`;
            state.executionArn = `arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${args.name}`;
            break;
          default:
            break;
        }
        return { id: `${args.name}-id`, state };
      },
      call: (args: pulumi.runtime.MockCallArgs) => ({
        ...args.inputs,
        name: REGION,
        region: REGION,
        accountId: ACCOUNT_ID,
      }),
    },
    "boxalarm-infra",
    "dev",
  );
  pulumi.runtime.setAllConfig({
    "boxalarm-infra:env": "dev",
    "boxalarm-infra:webOrigin": "https://localhost:5173",
    ...config,
  });
}

/** Full-stack config (index.ts requires these). */
export const STACK_CONFIG: Record<string, string> = {
  "boxalarm-infra:nerisSchemaSourceUrl": "https://schema.example.test/neris",
  "boxalarm-infra:deptId": "nichols-fd",
  "boxalarm-infra:smsWebhookSecret": "test-sms-secret",
  "boxalarm-infra:voiceWebhookSecret": "test-voice-secret",
  "boxalarm-infra:pushWebhookSecret": "test-push-secret",
  "boxalarm-infra:canaryMemberId": "test-canary-member",
};

/** Waits until no new mocked resources appear — index.ts registers many via apply(). */
export async function settleStack(): Promise<void> {
  let previous = -1;
  let stableRounds = 0;
  while (stableRounds < 5) {
    await new Promise((r) => setTimeout(r, 20));
    stableRounds = resources.length === previous ? stableRounds + 1 : 0;
    previous = resources.length;
  }
}

/** Lets pending Output.apply chains register their resources with the mock monitor. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

export function resourcesOfType(type: string): MockedResource[] {
  return resources.filter((r) => r.type === type);
}

export function lambdaByName(functionName: string): MockedResource {
  const fn = resourcesOfType("aws:lambda/function:Function").find(
    (r) => r.inputs.name === functionName,
  );
  if (!fn) {
    const names = resourcesOfType("aws:lambda/function:Function").map((r) => r.inputs.name);
    throw new Error(`no Lambda named ${functionName}; have: ${names.join(", ")}`);
  }
  return fn;
}

export function lambdaEnv(functionName: string): Record<string, string> {
  const environment = lambdaByName(functionName).inputs.environment as
    { variables?: Record<string, string> } | undefined;
  return environment?.variables ?? {};
}

/** Every Allow/Deny statement attached (inline) to the role named `roleName`. */
export function statementsForRole(roleName: string): PolicyStatement[] {
  const role = resourcesOfType("aws:iam/role:Role").find((r) => r.inputs.name === roleName);
  if (!role) {
    throw new Error(`no IAM role named ${roleName}`);
  }
  const roleId = `${role.name}-id`;
  return resourcesOfType("aws:iam/rolePolicy:RolePolicy")
    .filter((p) => p.inputs.role === roleId)
    .flatMap(
      (p) => (JSON.parse(p.inputs.policy as string) as { Statement: PolicyStatement[] }).Statement,
    );
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/** The Allow statements granting `action` on a resource matching `resource`. */
export function grantsFor(
  statements: PolicyStatement[],
  action: string,
  resource: string | ((r: string) => boolean),
): PolicyStatement[] {
  const matches = typeof resource === "string" ? (r: string) => r === resource : resource;
  return statements.filter(
    (s) =>
      s.Effect === "Allow" &&
      asArray(s.Action).includes(action) &&
      asArray(s.Resource).some((r) => matches(r)),
  );
}

export function isGranted(
  statements: PolicyStatement[],
  action: string,
  resource: string | ((r: string) => boolean),
): boolean {
  return grantsFor(statements, action, resource).length > 0;
}

export function esmFor(functionName: string): MockedResource {
  const esm = resourcesOfType("aws:lambda/eventSourceMapping:EventSourceMapping").find(
    (r) => r.inputs.functionName === functionName,
  );
  if (!esm) {
    throw new Error(`no event source mapping for ${functionName}`);
  }
  return esm;
}

export function alarmByName(alarmName: string): MockedResource {
  const alarm = resourcesOfType("aws:cloudwatch/metricAlarm:MetricAlarm").find(
    (r) => r.inputs.name === alarmName,
  );
  if (!alarm) {
    const names = resourcesOfType("aws:cloudwatch/metricAlarm:MetricAlarm").map(
      (r) => r.inputs.name,
    );
    throw new Error(`no alarm named ${alarmName}; have: ${names.join(", ")}`);
  }
  return alarm;
}

export const TABLE_ARN = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-alerting-table`;
export const STREAM_ARN = `${TABLE_ARN}/stream/2026-01-01T00:00:00.000`;
export const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:boxalarm-dev-alerting-topic.fifo`;
export const CMK_ARN = `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/alerting-cmk`;
export const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT_ID}:policy/boxalarm-dev-alerting-plane-boundary`;

/** The escalation → fan-out → dispatch-ingress slice of the alerting chain, wired as index.ts does. */
export async function buildSchedulingChain() {
  const alertingLogGroup = new ServiceLogGroup("alerting-lg", {
    env: "dev",
    serviceName: "alerting-service",
  });
  const platformLogGroup = new ServiceLogGroup("platform-lg", {
    env: "dev",
    serviceName: "platform-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup,
  });
  const escalation = new Escalation("escalation", {
    env: "dev",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTopicArn: TOPIC_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    logGroup: alertingLogGroup,
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  const fanOut = new FanOut("fan-out", {
    env: "dev",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    alertingStreamArn: STREAM_ARN,
    alertingTopicArn: TOPIC_ARN,
    escalation,
    logGroup: alertingLogGroup,
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  const routesCore = new RoutesCore("routes-core", {
    env: "dev",
    httpApi,
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    logGroup: alertingLogGroup,
    escalation,
    policyStoreId: "policy-store-id",
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
  return { alertingLogGroup, httpApi, escalation, fanOut, routesCore };
}

export const SCHEDULING_LAMBDAS = [
  "boxalarm-dev-alerting-fan-out",
  "boxalarm-dev-alerting-dispatches-create",
  "boxalarm-dev-alerting-tone-evaluator",
] as const;
