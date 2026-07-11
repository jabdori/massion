import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { ExtensionPackageService } from "@massion/extension-host";
import { afterAll, describe, expect, it, vi } from "vitest";

import { RegistryCatalog } from "./catalog.js";
import { RegistryInspectionPipeline } from "./pipeline.js";
import { MemoryArtifactStore, RegistryService } from "./service.js";
import { MemoryRegistryStore } from "./store.js";

const destinations: string[] = [];
afterAll(async () => {
  await Promise.all(destinations.map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("Official Registry seed", () => {
  it("Slack·Discord·GitHub 실제 npm pack artifact를 검사·공개·검색한다", async () => {
    const runtime = { agentOS: "1.0.0", node: process.versions.node, surrealDB: "3.2.0" };
    const packages = new ExtensionPackageService({ runtime });
    const store = new MemoryRegistryStore();
    const artifacts = new MemoryArtifactStore();
    const pipeline = new RegistryInspectionPipeline({
      provenance: {
        verify: vi.fn(async () => ({
          outcome: "pass" as const,
          issuer: "official-build",
          identity: "massion/official",
          predicateType: "https://slsa.dev/provenance/v1",
        })),
      },
      vulnerabilities: { query: vi.fn(async () => []) },
      contractProbe: { probe: vi.fn(async () => ({ outcome: "pass" as const })) },
      policy: { assess: vi.fn(async () => ({ outcome: "pass" as const, risk: "low" as const })) },
    });
    const service = new RegistryService({ store, artifacts, pipeline, grants: { consume: vi.fn(() => ({})) } });
    for (const name of ["slack", "discord", "github"] as const) {
      const destination = await mkdtemp(resolve(tmpdir(), `massion-${name}-registry-`));
      destinations.push(destination);
      const packed = await packages.pack(resolve(process.cwd(), "../../extensions", name), destination);
      await service.stage({
        commandId: `official-seed-${name}`,
        organizationId: "massion-official",
        uploadGrant: "official-grant",
        archive: await readFile(packed.tarballPath),
        provenanceBundle: {},
        provenancePolicy: { issuer: "official-build", identity: /^massion\/official$/u },
        runtime,
        visibility: "public",
        publicationPolicy: "automatic",
      });
    }
    const catalog = new RegistryCatalog(store, { tokenSecret: Buffer.alloc(32, 5) });
    const result = await catalog.search({ organizationId: "community", query: "", runtime, limit: 10 });
    expect(result.items.map((item) => item.packageName).sort()).toEqual([
      "@massion-ext/discord",
      "@massion-ext/github",
      "@massion-ext/slack",
    ]);
  }, 30_000);
});
