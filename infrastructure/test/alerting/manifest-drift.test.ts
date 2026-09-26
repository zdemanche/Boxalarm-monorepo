import * as path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it, vi } from "vitest";
import { STACK_CONFIG, installMocks, settleStack } from "./mock-harness";

/**
 * Guards the backend manifest ↔ infra seam: a key typo on either side silently deploys the
 * fail-closed 501 placeholder (lambdaCode only logs a warning). Every alerting-service and
 * apparatus-service entry in backend/scripts/lambda-manifest.mjs must be wired by a
 * lambdaCode() call in the full stack, and every such lambdaCode() call must name a manifest
 * entry.
 */

const GUARDED_SERVICES = new Set(["alerting-service", "apparatus-service"]);

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

interface ManifestEntry {
  service: string;
  function: string;
  entry: string;
}

async function manifestKeys(): Promise<Set<string>> {
  const manifestPath = path.resolve(__dirname, "../../../backend/scripts/lambda-manifest.mjs");
  const { LAMBDA_ENTRIES } = (await import(pathToFileURL(manifestPath).href)) as {
    LAMBDA_ENTRIES: ManifestEntry[];
  };
  return new Set(
    LAMBDA_ENTRIES.filter((e) => GUARDED_SERVICES.has(e.service)).map(
      (e) => `${e.service}/${e.function}`,
    ),
  );
}

describe("backend lambda manifest ↔ infra lambdaCode() drift", { timeout: 120_000 }, () => {
  it("alerting-service and apparatus-service keys match in both directions", async () => {
    installMocks(STACK_CONFIG);
    await import("../../index");
    await settleStack();

    const manifest = await manifestKeys();
    const wired = new Set(
      [...lambdaCodeCalls].filter((key) => GUARDED_SERVICES.has(key.split("/")[0]!)),
    );
    expect(manifest.size).toBeGreaterThan(20);

    const inManifestNotWired = [...manifest].filter((key) => !wired.has(key)).sort();
    const wiredNotInManifest = [...wired].filter((key) => !manifest.has(key)).sort();
    expect(inManifestNotWired, "manifest entries with no lambdaCode() call").toEqual([]);
    expect(wiredNotInManifest, "lambdaCode() calls with no manifest entry").toEqual([]);
  });
});
