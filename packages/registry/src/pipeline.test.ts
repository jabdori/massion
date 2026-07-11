import { describe, expect, it, vi } from "vitest";

import { RegistryInspectionPipeline } from "./pipeline.js";

const artifact = {
  packageJson: {
    name: "@massion-ext/github",
    version: "1.0.0",
    dependencies: { octokit: "5.0.0" },
  },
  manifest: {
    name: "@massion-ext/github",
    version: "1.0.0",
    permissions: { network: [] },
  },
  artifactDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  files: [],
};

describe("Registry inspection pipeline", () => {
  it("archive·provenance·SBOM·OSV·worker·policy를 모두 통과해야 pass한다", async () => {
    const pipeline = new RegistryInspectionPipeline({
      inspectArchive: vi.fn(async () => artifact as never),
      provenance: {
        verify: vi.fn(async () => ({
          outcome: "pass" as const,
          issuer: "issuer",
          identity: "identity",
          predicateType: "https://slsa.dev/provenance/v1",
        })),
      },
      vulnerabilities: { query: vi.fn(async () => []) },
      contractProbe: { probe: vi.fn(async () => ({ outcome: "pass" as const })) },
      policy: { assess: vi.fn(async () => ({ outcome: "pass" as const, risk: "low" as const })) },
    });
    const result = await pipeline.inspect({
      archive: Buffer.from("archive"),
      provenanceBundle: {},
      provenancePolicy: { issuer: "issuer", identity: /^identity$/u },
      runtime: { agentOS: "1.0.0", node: "24.0.0", surrealDB: "3.2.0" },
    });
    expect(result.assessment).toEqual({
      archive: "pass",
      provenance: "pass",
      sbom: "pass",
      vulnerability: "pass",
      contract: "pass",
      policy: "pass",
    });
    expect(result.sbom.components).toEqual([{ ecosystem: "npm", name: "octokit", version: "5.0.0" }]);
  });

  it("OSV timeout·unknown과 알려진 high advisory를 fail-closed 처리한다", async () => {
    const common = {
      inspectArchive: vi.fn(async () => artifact as never),
      provenance: {
        verify: vi.fn(async () => ({
          outcome: "pass" as const,
          issuer: "issuer",
          identity: "identity",
          predicateType: "https://slsa.dev/provenance/v1",
        })),
      },
      contractProbe: { probe: vi.fn(async () => ({ outcome: "pass" as const })) },
      policy: { assess: vi.fn(async () => ({ outcome: "pass" as const, risk: "low" as const })) },
    };
    const unknown = new RegistryInspectionPipeline({
      ...common,
      vulnerabilities: {
        query: vi.fn(async () => {
          throw new Error("timeout");
        }),
      },
    });
    expect(
      (
        await unknown.inspect({
          archive: Buffer.from("archive"),
          provenanceBundle: {},
          provenancePolicy: { issuer: "issuer", identity: /^identity$/u },
          runtime: { agentOS: "1.0.0", node: "24.0.0" },
        })
      ).assessment.vulnerability,
    ).toBe("unknown");
    const vulnerable = new RegistryInspectionPipeline({
      ...common,
      vulnerabilities: { query: vi.fn(async () => [{ id: "GHSA-test", severity: "high" as const }]) },
    });
    expect(
      (
        await vulnerable.inspect({
          archive: Buffer.from("archive"),
          provenanceBundle: {},
          provenancePolicy: { issuer: "issuer", identity: /^identity$/u },
          runtime: { agentOS: "1.0.0", node: "24.0.0" },
        })
      ).assessment.vulnerability,
    ).toBe("fail");
  });
});
