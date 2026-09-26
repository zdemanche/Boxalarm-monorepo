import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertingCmkStatement } from "../../components/alerting/alerting-cmk";
import {
  STACK_CONFIG,
  grantsFor,
  installMocks,
  resourcesOfType,
  settleStack,
  type PolicyStatement,
} from "./mock-harness";

describe("alertingCmkStatement", () => {
  it("scopes every DynamoDB-needed KMS action to the key, via DynamoDB in the key's region only", () => {
    const statement = alertingCmkStatement("arn:aws:kms:us-east-1:123456789012:key/abc");
    expect(statement.Resource).toBe("arn:aws:kms:us-east-1:123456789012:key/abc");
    expect(statement.Action).toEqual(
      expect.arrayContaining([
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
      ]),
    );
    expect(statement.Condition).toEqual({
      StringEquals: { "kms:ViaService": ["dynamodb.us-east-1.amazonaws.com"] },
    });
  });

  it("rejects a non-ARN key reference instead of emitting an unscoped grant", () => {
    expect(() => alertingCmkStatement("alias/alerting")).toThrow(/KMS key ARN/);
  });
});

describe(
  "every role that touches the alerting table can use its CMK (full stack)",
  { timeout: 120_000 },
  () => {
    beforeEach(() => {
      vi.resetModules();
      installMocks(STACK_CONFIG);
    });

    it("grants kms:Decrypt on the alerting CMK to each role with alerting-table access", async () => {
      await import("../../index");
      await settleStack();

      const table = resourcesOfType("aws:dynamodb/table:Table").find((t) =>
        (t.inputs.name as string).includes("alerting"),
      );
      expect(table).toBeDefined();
      const tableArn = `arn:aws:dynamodb:us-east-1:123456789012:table/${table!.inputs.name as string}`;
      const kmsKeyArns = resourcesOfType("aws:kms/key:Key").map(
        (k) => `arn:aws:kms:us-east-1:123456789012:key/${k.name}`,
      );

      const statementsByRole = new Map<string, PolicyStatement[]>();
      for (const policy of resourcesOfType("aws:iam/rolePolicy:RolePolicy")) {
        const statements = (
          JSON.parse(policy.inputs.policy as string) as { Statement: PolicyStatement[] }
        ).Statement;
        const role = policy.inputs.role as string;
        statementsByRole.set(role, [...(statementsByRole.get(role) ?? []), ...statements]);
      }

      const touchesTable = (r: string) => r === tableArn || r.startsWith(`${tableArn}/`);
      const offenders: string[] = [];
      let checked = 0;
      for (const [role, statements] of statementsByRole) {
        const tableAccess = statements.some(
          (s) =>
            s.Effect === "Allow" &&
            (Array.isArray(s.Action) ? s.Action : [s.Action]).some((a) =>
              a.startsWith("dynamodb:"),
            ) &&
            (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).some(touchesTable),
        );
        if (!tableAccess) continue;
        checked += 1;
        const canDecrypt =
          grantsFor(statements, "kms:Decrypt", (r) => kmsKeyArns.includes(r)).length > 0;
        if (!canDecrypt) offenders.push(role);
      }

      expect(checked).toBeGreaterThan(20);
      expect(offenders).toEqual([]);
    });
  },
);
