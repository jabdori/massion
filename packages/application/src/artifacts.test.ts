import { describe, expect, it } from "vitest";

import type { TenantContext } from "@massion/identity";

import { ApplicationArtifactGateway } from "./artifacts.js";

const context: TenantContext = {
  userId: "artifact-user",
  organizationId: "artifact-org",
  membershipId: "artifact-member",
  role: "owner",
};

describe("ApplicationArtifactGateway", () => {
  it("검사 결과에서 package 원문을 숨기고 설치는 domain gateway command로 위임한다", async () => {
    const installs: unknown[] = [];
    const gateway = new ApplicationArtifactGateway(
      {
        install: async (_context, input) => {
          installs.push(input);
          return { installationId: "installation-1" };
        },
      },
      async () => ({
        artifactDigest: "a".repeat(64),
        contentDigest: "b".repeat(64),
        manifest: { name: "@massion-ext/test", version: "1.0.0", runtime: { entrypoint: "dist/index.js" } },
        files: [{ path: "dist/index.js", size: 1, digest: "c".repeat(64), mode: 0o644 }],
        packageJson: { scripts: { postinstall: "secret" } },
      }),
    );
    const inspected = await gateway.inspect(context, Buffer.from("archive"));
    expect(inspected).toMatchObject({ packageName: "@massion-ext/test", packageVersion: "1.0.0", fileCount: 1 });
    expect(JSON.stringify(inspected)).not.toContain("postinstall");
    await expect(
      gateway.install(context, { commandId: "artifact-install-0001", archive: Buffer.from("archive") }),
    ).resolves.toEqual({ installationId: "installation-1" });
    expect(installs).toHaveLength(1);
  });
});
