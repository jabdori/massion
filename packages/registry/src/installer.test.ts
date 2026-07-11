import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { RegistryInstaller } from "./installer.js";

const context = { organizationId: "org-install", userId: "user-install", role: "owner" } as never;

describe("Registry installer", () => {
  it("grant·recall·artifact digest·archive identity를 재검증한 뒤 Host에 verified install한다", async () => {
    const body = Buffer.from("registry artifact");
    const digest = createHash("sha256").update(body).digest("hex");
    const version = { versionId: "version-1", packageName: "@massion-ext/slack", packageVersion: "1.0.0", artifactDigest: digest, state: "published" as const };
    const installRegistry = vi.fn(async () => ({ packageName: version.packageName, packageVersion: version.packageVersion }));
    const installer = new RegistryInstaller({
      catalog: { verifyDownload: vi.fn(async () => version as never) },
      artifacts: { get: vi.fn(async () => body), put: vi.fn() },
      inspectArchive: vi.fn(async () => ({ manifest: { name: version.packageName, version: version.packageVersion }, artifactDigest: digest } as never)),
      lifecycle: { installRegistry },
      runtime: { agentOS: "1.0.0", node: "24.0.0", surrealDB: "3.2.0" },
    });
    await installer.install(context, {
      commandId: "registry-install-0001",
      downloadGrant: "grant",
      environment: "production",
      riskClass: "medium",
      executionId: "execution-0001",
    });
    expect(installRegistry).toHaveBeenCalledWith(context, expect.objectContaining({ archive: body, trustLevel: "verified" }));
  });

  it("download 뒤 byte가 바뀌면 Host를 호출하지 않는다", async () => {
    const lifecycle = { installRegistry: vi.fn() };
    const installer = new RegistryInstaller({
      catalog: { verifyDownload: vi.fn(async () => ({ versionId: "v", packageName: "@massion-ext/slack", packageVersion: "1.0.0", artifactDigest: "a".repeat(64), state: "published" } as never)) },
      artifacts: { get: vi.fn(async () => Buffer.from("changed")), put: vi.fn() },
      inspectArchive: vi.fn(),
      lifecycle,
      runtime: { agentOS: "1.0.0", node: "24.0.0" },
    });
    await expect(installer.install(context, { commandId: "registry-install-0002", downloadGrant: "grant", environment: "production", riskClass: "medium", executionId: "execution-0002" })).rejects.toThrow("digest");
    expect(lifecycle.installRegistry).not.toHaveBeenCalled();
  });
});
