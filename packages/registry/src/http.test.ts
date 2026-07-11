import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { RegistryCatalog } from "./catalog.js";
import { RegistryHttpHandler } from "./http.js";
import { MemoryArtifactStore } from "./service.js";
import { MemoryRegistryStore } from "./store.js";

describe("npm compatible Registry HTTP", () => {
  it("packument에 signed tarball URL을 만들고 byte를 integrity 그대로 반환하며 DELETE를 거부한다", async () => {
    const body = Buffer.from("npm artifact");
    const digest = createHash("sha256").update(body).digest("hex");
    const store = new MemoryRegistryStore();
    const artifacts = new MemoryArtifactStore();
    await artifacts.put(digest, body);
    const staged = await store.stage("registry-http-stage-1", {
      packageName: "@massion-ext/slack",
      packageVersion: "1.0.0",
      artifactDigest: digest,
      contentDigest: "b".repeat(64),
      visibility: "public",
      ownerOrganizationId: "org-owner",
      manifest: { description: "Slack", compatibility: { agentOS: "^1.0.0", node: ">=24" } },
    });
    await store.recordAssessment(staged.versionId, {
      archive: "pass",
      provenance: "pass",
      sbom: "pass",
      vulnerability: "pass",
      contract: "pass",
      policy: "pass",
    });
    await store.publish(staged.versionId, "decision-http-1");
    const catalog = new RegistryCatalog(store, { tokenSecret: Buffer.alloc(32, 8) });
    const handler = new RegistryHttpHandler({ catalog, artifacts, publicBaseUrl: "https://registry.massion.dev" });
    const metadata = await handler.handle(
      new Request("https://registry.massion.dev/npm/%40massion-ext%2Fslack"),
      "org-other",
    );
    expect(metadata.status).toBe(200);
    const packument = (await metadata.json()) as { versions: Record<string, { dist: { tarball: string } }> };
    const tarball = await handler.handle(new Request(packument.versions["1.0.0"]?.dist.tarball ?? ""), "org-other");
    expect(Buffer.from(await tarball.arrayBuffer())).toEqual(body);
    expect(
      (
        await handler.handle(
          new Request("https://registry.massion.dev/npm/%40massion-ext%2Fslack", { method: "DELETE" }),
          "org-owner",
        )
      ).status,
    ).toBe(405);
  });
});
