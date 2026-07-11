import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MemoryArtifactStore, RegistryService } from "./service.js";
import { MemoryRegistryStore } from "./store.js";

describe("Registry publish service", () => {
  it("grant→검사→immutable blob→stage→automatic publish를 하나의 계보로 처리한다", async () => {
    const archive = Buffer.from("artifact");
    const digest = createHash("sha256").update(archive).digest("hex");
    const store = new MemoryRegistryStore();
    const service = new RegistryService({
      store,
      artifacts: new MemoryArtifactStore(),
      pipeline: {
        inspect: vi.fn(
          async () =>
            ({
              artifact: {
                manifest: {
                  name: "@massion-ext/slack",
                  version: "1.0.0",
                  description: "Slack",
                  compatibility: { agentOS: "^1.0.0", node: ">=24" },
                },
                artifactDigest: digest,
                contentDigest: "b".repeat(64),
              },
              assessment: {
                archive: "pass",
                provenance: "pass",
                sbom: "pass",
                vulnerability: "pass",
                contract: "pass",
                policy: "pass",
              },
            }) as never,
        ),
      },
      grants: { consume: vi.fn(() => ({ publisherId: "publisher-1" })) },
    });
    const result = await service.stage({
      commandId: "registry-stage-0001",
      organizationId: "org-owner",
      uploadGrant: "grant",
      archive,
      provenanceBundle: {},
      provenancePolicy: { issuer: "issuer", identity: /^identity$/u },
      runtime: { agentOS: "1.0.0", node: "24.0.0" },
      visibility: "public",
      publicationPolicy: "automatic",
    });
    expect(result.state).toBe("published");
    expect(await service.artifact(digest)).toEqual(archive);
  });
});
