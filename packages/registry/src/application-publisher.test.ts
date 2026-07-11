import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { RegistryApplicationPublisher } from "./application-publisher.js";

const context = { organizationId: "org-owner", userId: "user-owner", role: "owner" } as never;

describe("Registry Application publisher", () => {
  it("서버 trust policy를 사용하고 client가 보낸 임의 policy field를 거부한다", async () => {
    const archive = Buffer.from("artifact");
    const artifactDigest = createHash("sha256").update(archive).digest("hex");
    const publish = vi.fn(async () => ({ versionId: "version-1", state: "published" }) as never);
    const publisher = new RegistryApplicationPublisher({
      pipeline: {
        inspect: vi.fn(
          async () =>
            ({
              artifact: {
                manifest: { name: "@massion-ext/slack", version: "1.0.0" },
                artifactDigest,
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
      grants: { consume: vi.fn(() => ({})) },
      artifacts: { put: vi.fn(), get: vi.fn() },
      versions: {
        stage: vi.fn(async () => ({ versionId: "version-1" }) as never),
        recordAssessment: vi.fn(
          async () =>
            ({
              versionId: "version-1",
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
        publish,
      },
      runtime: { agentOS: "1.0.0", node: "24.0.0" },
      provenancePolicy: { issuer: "trusted-issuer", identity: /^trusted-identity$/u },
    });
    await expect(
      publisher.publish(context, {
        commandId: "publisher-command-1",
        archive,
        metadata: {
          uploadGrant: "grant",
          provenanceBundle: {},
          visibility: "public",
          publicationPolicy: "automatic",
          provenancePolicy: { issuer: "attacker" },
        },
      }),
    ).rejects.toThrow("알 수 없는 필드");
    await expect(
      publisher.publish(context, {
        commandId: "publisher-command-2",
        archive,
        metadata: { uploadGrant: "grant", provenanceBundle: {}, visibility: "public", publicationPolicy: "automatic" },
      }),
    ).resolves.toMatchObject({ state: "published" });
    expect(publish).toHaveBeenCalledOnce();
  });
});
