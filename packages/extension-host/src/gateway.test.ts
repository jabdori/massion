import type { TenantContext } from "@massion/identity";
import { describe, expect, it } from "vitest";

import { ExtensionGateway } from "./gateway.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("ExtensionGateway", () => {
  it("허용된 lifecycle·package surface만 위임하고 내부 path·process를 반환하지 않는다", async () => {
    const lifecycle = {
      install: async () => ({ installationId: "installation-1", packageName: "@massion-ext/echo", state: "active" }),
      update: async () => ({ installationId: "installation-1", packageName: "@massion-ext/echo", state: "active" }),
      rollback: async () => ({ installationId: "installation-1", packageName: "@massion-ext/echo", state: "active" }),
      list: async () => [{ installationId: "installation-1", packageName: "@massion-ext/echo", state: "active" }],
      invoke: async () => ({ ok: true }),
    };
    const packages = {
      validate: async () => ({
        sourcePath: "/secret/path",
        sourceDigest: "a".repeat(64),
        manifest: { name: "@massion-ext/echo", version: "1.0.0" },
        files: ["dist/worker.js"],
      }),
      link: async () => ({
        sourcePath: "/secret/path",
        sourceDigest: "a".repeat(64),
        trustLevel: "untrusted-local",
        validatedAt: new Date().toISOString(),
      }),
      pack: async () => ({
        tarballPath: "/secret/output.tgz",
        artifact: { artifactDigest: "b".repeat(64), manifest: { name: "@massion-ext/echo", version: "1.0.0" } },
      }),
    };
    const gateway = new ExtensionGateway(lifecycle, packages);

    const validated = await gateway.validate("./echo");
    const linked = await gateway.link("./echo", { environment: "development" });
    const packed = await gateway.pack("./echo", "./dist");
    const installed = await gateway.install(context, { commandId: "install", archive: Buffer.from("tgz") });

    expect(validated).toEqual({
      sourceDigest: "a".repeat(64),
      packageName: "@massion-ext/echo",
      packageVersion: "1.0.0",
      files: ["dist/worker.js"],
    });
    expect(linked).not.toHaveProperty("sourcePath");
    expect(packed).not.toHaveProperty("tarballPath");
    expect(JSON.stringify(installed)).not.toContain("path");
  });
});
