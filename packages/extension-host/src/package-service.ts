import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { validateExtensionManifest, type ExtensionManifestV1 } from "@massion/extension-sdk";
import semver from "semver";

import { inspectExtensionArchive } from "./artifact-inspector.js";
import type { ExtensionArtifactReport, ExtensionRuntimeVersions } from "./contracts.js";
import { assertNoEmbeddedCredential, assertSafeExtensionFile, validatePackageSecurity } from "./security.js";

export interface ExtensionCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

export interface ExtensionDirectoryReport {
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly packageJson: Readonly<Record<string, unknown>>;
  readonly manifest: ExtensionManifestV1;
  readonly files: readonly string[];
}

export interface LinkedExtension {
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly trustLevel: "untrusted-local";
  readonly validatedAt: string;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(body: Buffer, label: string): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} JSON이 유효하지 않습니다`);
  }
}

function verifyCompatibility(manifest: ExtensionManifestV1, runtime: ExtensionRuntimeVersions): void {
  for (const [range, version, label] of [
    [manifest.compatibility.agentOS, runtime.agentOS, "AgentOS"],
    [manifest.compatibility.node, runtime.node, "Node.js"],
    [manifest.compatibility.surrealDB ?? "*", runtime.surrealDB, "SurrealDB"],
  ] as const) {
    if (!semver.validRange(range) || (version !== undefined && !semver.satisfies(version, range))) {
      throw new Error(`${label} runtime version이 Extension 호환 범위를 벗어났습니다`);
    }
  }
}

class NodeExtensionCommandRunner implements ExtensionCommandRunner {
  public async run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    return await new Promise((resolveResult, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        shell: false,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      const capture = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          child.kill("SIGKILL");
          reject(new Error("npm pack 출력 byte 상한을 초과했습니다"));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        capture(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        capture(stderr, chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolveResult({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  }
}

export class ExtensionPackageService {
  private readonly runner: ExtensionCommandRunner;

  public constructor(
    private readonly options: {
      readonly runtime: ExtensionRuntimeVersions;
      readonly commandRunner?: ExtensionCommandRunner;
    },
  ) {
    this.runner = options.commandRunner ?? new NodeExtensionCommandRunner();
  }

  public async validate(source: string): Promise<ExtensionDirectoryReport> {
    const root = await realpath(source);
    if (!(await lstat(root)).isDirectory()) throw new Error("Extension source는 directory여야 합니다");
    const files = new Map<string, Buffer>();
    let total = 0;
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const entry of entries) {
        const absolute = join(directory, entry.name);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error(`Extension source link를 허용하지 않습니다: ${entry.name}`);
        if (stat.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!stat.isFile()) throw new Error(`Extension source file type을 허용하지 않습니다: ${entry.name}`);
        const path = relative(root, absolute).split(sep).join("/");
        assertSafeExtensionFile(path);
        if (files.size >= 10_000) throw new Error("Extension source entry 상한을 초과했습니다");
        if (stat.size > 16 * 1024 * 1024) throw new Error(`Extension source file byte 상한을 초과했습니다: ${path}`);
        total += stat.size;
        if (total > 128 * 1024 * 1024) throw new Error("Extension source byte 상한을 초과했습니다");
        const body = await readFile(absolute);
        assertNoEmbeddedCredential(path, body);
        files.set(path, body);
      }
    };
    await visit(root);
    const packageBody = files.get("package.json");
    if (!packageBody) throw new Error("Extension source에 package.json이 없습니다");
    const packageJson = validatePackageSecurity(parseJson(packageBody, "package.json"));
    const massion = packageJson.massion;
    if (!massion || typeof massion !== "object" || Array.isArray(massion)) {
      throw new Error("package.json massion.manifest가 없습니다");
    }
    const manifestPath = (massion as Record<string, unknown>).manifest;
    if (typeof manifestPath !== "string") throw new Error("package.json massion.manifest가 유효하지 않습니다");
    const manifestBody = files.get(manifestPath);
    if (!manifestBody) throw new Error("Extension manifest file이 없습니다");
    const manifest = validateExtensionManifest(parseJson(manifestBody, "Extension manifest"));
    if (packageJson.name !== manifest.name || packageJson.version !== manifest.version) {
      throw new Error("package와 manifest identity가 일치하지 않습니다");
    }
    if (packageJson.type !== "module") throw new Error("Extension package type은 module이어야 합니다");
    if (!files.has(manifest.runtime.entrypoint)) throw new Error("Extension runtime entrypoint file이 없습니다");
    verifyCompatibility(manifest, this.options.runtime);
    const content = [...files]
      .map(([path, body]) => ({ path, size: body.length, digest: sha256(body) }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return {
      sourcePath: root,
      sourceDigest: sha256(canonicalJson(content)),
      packageJson: structuredClone(packageJson),
      manifest: structuredClone(manifest),
      files: content.map((entry) => entry.path),
    };
  }

  public async link(source: string, options: { readonly environment: string }): Promise<LinkedExtension> {
    if (options.environment === "production")
      throw new Error("production environment에서는 local Extension link를 허용하지 않습니다");
    const report = await this.validate(source);
    return {
      sourcePath: report.sourcePath,
      sourceDigest: report.sourceDigest,
      trustLevel: "untrusted-local",
      validatedAt: new Date().toISOString(),
    };
  }

  public async isLinkFresh(link: LinkedExtension): Promise<boolean> {
    try {
      return (await this.validate(link.sourcePath)).sourceDigest === link.sourceDigest;
    } catch {
      return false;
    }
  }

  public async pack(
    source: string,
    destination: string,
  ): Promise<{ readonly tarballPath: string; readonly artifact: ExtensionArtifactReport }> {
    const sourceReport = await this.validate(source);
    const target = resolve(destination);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const result = await this.runner.run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", target], {
      cwd: sourceReport.sourcePath,
    });
    if (result.exitCode !== 0) throw new Error(`npm pack이 실패했습니다: exit ${String(result.exitCode)}`);
    let output: unknown;
    try {
      output = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("npm pack JSON 결과가 유효하지 않습니다");
    }
    const items: unknown[] = Array.isArray(output) ? (output as unknown[]) : [];
    const item: unknown = items[0];
    const filename = item && typeof item === "object" ? (item as Record<string, unknown>).filename : undefined;
    if (typeof filename !== "string" || filename !== basename(filename) || !filename.endsWith(".tgz")) {
      throw new Error("npm pack filename이 유효하지 않습니다");
    }
    const tarballPath = join(target, filename);
    const artifact = await inspectExtensionArchive(await readFile(tarballPath), { runtime: this.options.runtime });
    if (
      artifact.manifest.name !== sourceReport.manifest.name ||
      artifact.manifest.version !== sourceReport.manifest.version ||
      canonicalJson(artifact.manifest) !== canonicalJson(sourceReport.manifest)
    ) {
      throw new Error("packed Extension manifest가 검증한 source와 일치하지 않습니다");
    }
    return { tarballPath, artifact };
  }
}
