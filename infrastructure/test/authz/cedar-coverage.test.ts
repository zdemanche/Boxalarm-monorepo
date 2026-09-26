import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it, vi } from "vitest";
import { STACK_CONFIG, installMocks, settleStack } from "../alerting/mock-harness";

/**
 * Every Cedar call a deployed handler makes must name a declared action on a declared
 * resource type, and some policy must be able to permit it. The policy store validates
 * STRICT, so anything else fails on every request - which is how every alerting and
 * push-token route (and riding-board, apparatus, inspections before them) shipped
 * denying all callers: handlers sent 'MEMBER' / 'AlertingService' / 'Dispatch' and
 * actions the schema never declared, and no test compared the two sides.
 *
 * Scope: the entry file of every Lambda the full stack wires (lambdaCode calls, resolved
 * through backend/scripts/lambda-manifest.mjs) plus its direct relative imports. Calls
 * whose action id is not a string literal are not checked.
 */

/**
 * Deployed actions still broken on this branch, fixed by a stacked change. The test fails
 * on a stale entry too, so remove each one as its fix lands.
 */
const KNOWN_BROKEN = new Set<string>([
  // reporting-service: non-namespaced types and undeclared actions (api-gap P1 #8).
  "GetLosapYearEnd",
  "ViewGrantsReport",
  "ViewMembershipTrends",
  // apparatus-service riding board (api-gap P0 #1).
  "AssignRidingPosition",
]);

const { lambdaCodeCalls } = vi.hoisted(() => ({ lambdaCodeCalls: new Set<string>() }));

vi.mock("../../components/shared/lambda-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/shared/lambda-code")>();
  return {
    ...actual,
    lambdaCode: (service: string, functionName: string) => {
      lambdaCodeCalls.add(`${service}/${functionName}`);
      return actual.lambdaCode(service, functionName);
    },
  };
});

const BACKEND_ROOT = path.resolve(__dirname, "../../../backend");

interface ManifestEntry {
  service: string;
  function: string;
  entry: string;
}

interface CedarCall {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
  readonly file: string;
}

function withRelativeImports(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const imports = [...src.matchAll(/from '(\.{1,2}\/[^']+)\.js'/g)].map((m) =>
    path.resolve(path.dirname(file), `${m[1]!}.ts`),
  );
  return [file, ...imports.filter((f) => fs.existsSync(f))];
}

function extractCedarCalls(file: string): CedarCall[] {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(BACKEND_ROOT, file);
  const guard = [
    ...src.matchAll(
      /actionType:\s*'([^']+)',\s*actionId:\s*'([^']+)',\s*resourceType:\s*'([^']+)'/g,
    ),
  ];
  const direct = [
    ...src.matchAll(
      /action:\s*\{\s*actionType:\s*'([^']+)',\s*actionId:\s*'([^']+)'\s*\},\s*resource:\s*\{\s*entityType:\s*'([^']+)'/g,
    ),
  ];
  return [...guard, ...direct].map((m) => ({
    actionType: m[1]!,
    actionId: m[2]!,
    resourceType: m[3]!,
    file: rel,
  }));
}

describe(
  "deployed handlers' Cedar calls ↔ policy store schema and policies",
  { timeout: 120_000 },
  () => {
    it("every call uses a declared Boxalarm:: action and resource type that a policy covers", async () => {
      installMocks(STACK_CONFIG);
      await import("../../index");
      await settleStack();

      const { LAMBDA_ENTRIES } = (await import(
        pathToFileURL(path.join(BACKEND_ROOT, "scripts/lambda-manifest.mjs")).href
      )) as { LAMBDA_ENTRIES: ManifestEntry[] };
      const files = new Set(
        LAMBDA_ENTRIES.filter((e) => lambdaCodeCalls.has(`${e.service}/${e.function}`)).flatMap(
          (e) => withRelativeImports(path.join(BACKEND_ROOT, e.entry)),
        ),
      );
      const calls = [...files].flatMap(extractCedarCalls);
      expect(calls.length).toBeGreaterThan(20);

      const policies = await import("../../components/authz/cedar-policies");
      const schema = JSON.parse(policies.CEDAR_SCHEMA) as {
        Boxalarm: {
          entityTypes: Record<string, unknown>;
          actions: Record<string, { appliesTo: { resourceTypes: string[] } }>;
        };
      };
      const policyText = Object.entries(policies)
        .filter(([name, fn]) => name.endsWith("Policy") && typeof fn === "function")
        .map(([, fn]) => (fn as (poolId: string) => string)("pool-1"))
        .join("\n");

      const problems = calls
        .filter((call) => !KNOWN_BROKEN.has(call.actionId))
        .flatMap((call) => {
          const where = `${call.file}: ${call.actionId}`;
          const errors: string[] = [];
          if (call.actionType !== "Boxalarm::Action") {
            errors.push(`${where} sends actionType '${call.actionType}'`);
          }
          const resource = call.resourceType.replace(/^Boxalarm::/, "");
          if (
            !call.resourceType.startsWith("Boxalarm::") ||
            !schema.Boxalarm.entityTypes[resource]
          ) {
            errors.push(`${where} sends undeclared resourceType '${call.resourceType}'`);
          }
          const action = schema.Boxalarm.actions[call.actionId];
          if (!action) {
            errors.push(`${where} is not a declared action`);
          } else if (!action.appliesTo.resourceTypes.includes(resource)) {
            errors.push(`${where} does not apply to ${call.resourceType}`);
          }
          if (!policyText.includes(`Boxalarm::Action::"${call.actionId}"`)) {
            errors.push(`${where} is in no policy (implicit DENY for everyone)`);
          }
          return errors;
        });

      expect(problems).toEqual([]);
      const stillBroken = new Set(
        calls
          .filter((c) => KNOWN_BROKEN.has(c.actionId))
          .filter(
            (c) =>
              c.actionType !== "Boxalarm::Action" ||
              !schema.Boxalarm.actions[c.actionId] ||
              !policyText.includes(`Boxalarm::Action::"${c.actionId}"`),
          )
          .map((c) => c.actionId),
      );
      expect(
        [...KNOWN_BROKEN].filter((a) => !stillBroken.has(a)),
        "KNOWN_BROKEN entries that now pass - remove them",
      ).toEqual([]);
    });
  },
);
