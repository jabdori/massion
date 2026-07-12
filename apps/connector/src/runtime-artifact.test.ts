import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertEdgeRuntimeArtifact, attestEdgeRuntimeArtifact } from "./runtime-artifact.js";
import { fixtureDirectory } from "./test-fixtures.js";

describe("Edge Provider 실행 파일 증명", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  it.each([
    ["google-gemini-cli-enterprise", ["--version"]],
    ["github-copilot", ["version"]],
    ["xai-grok-build", ["version"]],
  ] as const)("%s의 절대 regular file·SHA-256·공식 version 명령을 증명한다", async (providerId, arguments_) => {
    const fixture = await fixtureDirectory("massion-edge-runtime-");
    cleanups.push(fixture.cleanup);
    const executable = join(fixture.path, "provider-cli");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const runVersion = vi.fn(async () => ({ stdout: "provider cli 1.2.3\n" }));

    const artifact = await attestEdgeRuntimeArtifact({ providerId, executable }, { runVersion });

    expect(artifact).toEqual({
      executable,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      version: "1.2.3",
    });
    expect(runVersion).toHaveBeenCalledWith(executable, arguments_, {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    });
    await expect(assertEdgeRuntimeArtifact(providerId, artifact, { runVersion })).resolves.toEqual(artifact);
  });

  it("symlink·상대 경로·실행 중 변경된 digest를 fail-closed로 거부한다", async () => {
    const fixture = await fixtureDirectory("massion-edge-runtime-invalid-");
    cleanups.push(fixture.cleanup);
    const executable = join(fixture.path, "provider-cli");
    const link = join(fixture.path, "provider-link");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink(executable, link);
    const runVersion = vi.fn(async () => ({ stdout: "1.2.3" }));

    await expect(
      attestEdgeRuntimeArtifact({ providerId: "github-copilot", executable: "copilot" }, { runVersion }),
    ).rejects.toThrow(/절대 경로/u);
    await expect(
      attestEdgeRuntimeArtifact({ providerId: "github-copilot", executable: link }, { runVersion }),
    ).rejects.toThrow(/symlink|regular file/u);

    const artifact = await attestEdgeRuntimeArtifact({ providerId: "github-copilot", executable }, { runVersion });
    await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    await expect(assertEdgeRuntimeArtifact("github-copilot", artifact, { runVersion })).rejects.toThrow(/digest|변경/u);
  });

  it("지원하지 않는 Provider와 version 없는 출력은 identity 생성 전에 거부한다", async () => {
    const fixture = await fixtureDirectory("massion-edge-runtime-provider-");
    cleanups.push(fixture.cleanup);
    const executable = join(fixture.path, "provider-cli");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    await expect(
      attestEdgeRuntimeArtifact(
        { providerId: "google-antigravity-cli", executable },
        { runVersion: async () => ({ stdout: "1.2.3" }) },
      ),
    ).rejects.toThrow(/지원하지 않는 Edge Provider/u);
    await expect(
      attestEdgeRuntimeArtifact(
        { providerId: "xai-grok-build", executable },
        { runVersion: async () => ({ stdout: "unknown" }) },
      ),
    ).rejects.toThrow(/version/u);
  });
});
