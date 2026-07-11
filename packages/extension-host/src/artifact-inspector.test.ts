import { describe, expect, it } from "vitest";

import { inspectExtensionArchive } from "./artifact-inspector.js";
import { makeTar, validManifest, validPackage, validTar } from "./test-helpers.js";

const runtime = { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" };

describe("Extension artifact inspector", () => {
  it("npm tarball을 disk extraction 없이 검사하고 두 digest를 고정한다", async () => {
    const archive = validTar();
    const report = await inspectExtensionArchive(archive, { runtime });

    expect(report.packageJson).toMatchObject({ name: "@massion-ext/echo", version: "1.0.0" });
    expect(report.manifest).toEqual(validManifest);
    expect(report.artifactDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.files.map((file) => file.path)).toEqual([
      "LICENSE",
      "README.md",
      "dist/worker.js",
      "massion.extension.json",
      "package.json",
    ]);
  });

  it.each([
    ["traversal", [{ path: "package/../escape", body: "x" }], "path"],
    ["symlink", [{ path: "package/link", type: "SymbolicLink" as const, linkpath: "../outside" }], "link"],
    ["hardlink", [{ path: "package/link", type: "Link" as const, linkpath: "package/package.json" }], "link"],
    ["native addon", [{ path: "package/dist/addon.node", body: "native" }], "native"],
    ["binding.gyp", [{ path: "package/binding.gyp", body: "{}" }], "native"],
    ["node_modules", [{ path: "package/node_modules/a/index.js", body: "x" }], "node_modules"],
  ])("%s entry를 거부한다", async (_name, entries, message) => {
    await expect(inspectExtensionArchive(validTar(entries), { runtime })).rejects.toThrow(message);
  });

  it("중복 normalized path·entry count·압축 해제 byte 상한을 거부한다", async () => {
    await expect(
      inspectExtensionArchive(validTar([{ path: "package/README.md", body: "duplicate" }]), { runtime }),
    ).rejects.toThrow("중복");
    await expect(inspectExtensionArchive(validTar(), { runtime, limits: { maxEntries: 4 } })).rejects.toThrow("entry");
    await expect(inspectExtensionArchive(validTar(), { runtime, limits: { maxUnpackedBytes: 32 } })).rejects.toThrow(
      "byte",
    );
  });

  it("package 안의 credential 후보를 원문 노출 없이 거부한다", async () => {
    const archive = validTar([
      {
        path: "package/.env",
        body: "AUTHORIZATION=Bearer abcdefghijklmnopqrstuvwxyz",
      },
    ]);
    await expect(inspectExtensionArchive(archive, { runtime })).rejects.toThrow("credential");
  });

  it("package와 manifest identity·entrypoint·runtime compatibility를 검증한다", async () => {
    const mismatch = makeTar([
      { path: "package/package.json", body: JSON.stringify({ ...validPackage, version: "1.0.1" }) },
      { path: "package/massion.extension.json", body: JSON.stringify(validManifest) },
      { path: "package/dist/worker.js", body: "export {};" },
    ]);
    await expect(inspectExtensionArchive(mismatch, { runtime })).rejects.toThrow("version");

    const incompatible = makeTar([
      { path: "package/package.json", body: JSON.stringify(validPackage) },
      {
        path: "package/massion.extension.json",
        body: JSON.stringify({ ...validManifest, compatibility: { ...validManifest.compatibility, node: ">=25" } }),
      },
      { path: "package/dist/worker.js", body: "export {};" },
    ]);
    await expect(inspectExtensionArchive(incompatible, { runtime })).rejects.toThrow("호환");

    const missing = makeTar([
      { path: "package/package.json", body: JSON.stringify(validPackage) },
      { path: "package/massion.extension.json", body: JSON.stringify(validManifest) },
    ]);
    await expect(inspectExtensionArchive(missing, { runtime })).rejects.toThrow("entrypoint");
  });
});
