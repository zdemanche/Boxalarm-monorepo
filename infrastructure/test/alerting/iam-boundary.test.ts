import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: { ...args.inputs },
    }),
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("AlertingPlaneBoundary", () => {
  it("denies dynamodb:* on the platform and incident tables, their indexes, and every stream label (stream/*)", async () => {
    const { AlertingPlaneBoundary } = await import("../../components/alerting/iam-boundary");
    const boundary = new AlertingPlaneBoundary("boundary", {
      env: "dev",
      platformTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
      incidentTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/incident",
    });
    const policyJson = await resolve(boundary.policy.policy);
    const policy = JSON.parse(policyJson as unknown as string) as {
      Statement: { Sid: string; Effect: string; Resource: string[] }[];
    };
    const deny = policy.Statement.find((s) => s.Sid === "DenyNonAlertingTables")!;
    expect(deny.Effect).toBe("Deny");
    expect(deny.Resource).toEqual(
      expect.arrayContaining([
        "arn:aws:dynamodb:us-east-1:123456789012:table/platform",
        "arn:aws:dynamodb:us-east-1:123456789012:table/platform/index/*",
        "arn:aws:dynamodb:us-east-1:123456789012:table/platform/stream/*",
        "arn:aws:dynamodb:us-east-1:123456789012:table/incident",
        "arn:aws:dynamodb:us-east-1:123456789012:table/incident/index/*",
        "arn:aws:dynamodb:us-east-1:123456789012:table/incident/stream/*",
      ]),
    );
    expect(deny.Resource).not.toEqual(
      expect.arrayContaining([expect.stringContaining("alerting")]),
    );

    const name = await resolve(boundary.policy.name);
    expect(name).toBe("boxalarm-dev-alerting-plane-boundary");
  });
});
