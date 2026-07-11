import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExtensionPackageService, type ExtensionCommandRunner } from "./package-service.js";
import { validManifest, validPackage, validTar } from "./test-helpers.js";

const roots: string[] = [];
const runtime = { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" };

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "massion-extension-source-"));
  roots.push(root);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), JSON.stringify(validPackage));
  await writeFile(join(root, "massion.extension.json"), JSON.stringify(validManifest));
  await writeFile(join(root, "dist", "worker.js"), "export const worker = true;");
  await writeFile(join(root, "README.md"), "# Echo");
  await writeFile(join(root, "LICENSE"), "Apache-2.0");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("Extension package service", () => {
  it("local directory를 code 실행 없이 검증하고 source digest를 만든다", async () => {
    const source = await fixture();
    await mkdir(join(source, "node_modules", ".cache"), { recursive: true });
    await writeFile(join(source, "node_modules", ".cache", "state.json"), "{}");
    const service = new ExtensionPackageService({ runtime });

    const report = await service.validate(source);

    expect(report.manifest.name).toBe("@massion-ext/echo");
    expect(report.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.files).toContain("dist/worker.js");
    expect(report.files.some((path) => path.startsWith("node_modules/"))).toBe(false);
  });

  it("link는 canonical path와 validation digest를 저장하고 source 변경을 탐지한다", async () => {
    const source = await fixture();
    const service = new ExtensionPackageService({ runtime });
    const linked = await service.link(source, { environment: "development" });

    expect(linked.trustLevel).toBe("untrusted-local");
    expect(await service.isLinkFresh(linked)).toBe(true);
    await writeFile(join(source, "dist", "worker.js"), "export const changed = true;");
    expect(await service.isLinkFresh(linked)).toBe(false);
    await expect(service.link(source, { environment: "production" })).rejects.toThrow("production");
  });

  it("npm pack을 shell 없이 ignore-scripts로 실행하고 결과 tarball을 다시 검사한다", async () => {
    const source = await fixture();
    const destination = await mkdtemp(join(tmpdir(), "massion-extension-pack-"));
    roots.push(destination);
    const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
    const runner: ExtensionCommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        const output = join(destination, "massion-ext-echo-1.0.0.tgz");
        await writeFile(output, validTar());
        return { exitCode: 0, stdout: JSON.stringify([{ filename: basename(output) }]), stderr: "" };
      },
    };
    const service = new ExtensionPackageService({ runtime, commandRunner: runner });

    const packed = await service.pack(source, destination);

    expect(calls).toEqual([
      {
        command: "npm",
        args: ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
        cwd: await realpath(source),
      },
    ]);
    expect((await readFile(packed.tarballPath)).length).toBeGreaterThan(0);
    expect(packed.artifact.manifest.name).toBe("@massion-ext/echo");
  });
});
