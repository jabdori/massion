import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type BundledSubscriptionRuntimeId = "codex" | "claude";

export interface BundledSubscriptionRuntimeArtifact {
  readonly runtimeId: BundledSubscriptionRuntimeId;
  readonly version: string;
  readonly runtimeArtifactDigest: string;
  readonly command: string;
  readonly commandArguments: readonly string[];
}

interface PackageDocument {
  readonly name?: unknown;
  readonly version?: unknown;
}

interface RuntimeLayout {
  readonly runtimeId: BundledSubscriptionRuntimeId;
  readonly version: string;
  readonly roots: readonly { readonly label: string; readonly path: string }[];
  readonly files: readonly { readonly label: string; readonly path: string }[];
  readonly command: string;
  readonly commandArguments: readonly string[];
}

const MAXIMUM_ARTIFACT_FILES = 20_000;
const MAXIMUM_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const BUNDLED_RUNTIME_IDS = new Set<string>(["codex", "claude"]);

function packageName(runtimeId: BundledSubscriptionRuntimeId): string {
  return runtimeId === "codex" ? "@openai/codex-sdk" : "@anthropic-ai/claude-agent-sdk";
}

async function packageDocument(path: string, expectedName: string): Promise<PackageDocument & { version: string }> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error("Bundled runtime package metadata를 읽지 못했습니다", { cause: error });
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Bundled runtime package metadata가 유효하지 않습니다");
  }
  const document = decoded as PackageDocument;
  if (document.name !== expectedName || typeof document.version !== "string" || !document.version.trim()) {
    throw new Error("Bundled runtime package 계보가 일치하지 않습니다");
  }
  return { ...document, version: document.version };
}

async function findPackageRoot(entry: string, expectedName: string): Promise<string> {
  let directory = dirname(await realpath(entry));
  for (;;) {
    const candidate = join(directory, "package.json");
    try {
      await packageDocument(candidate, expectedName);
      return directory;
    } catch (error) {
      const parent = dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
}

async function dependencyRoot(
  fromRoot: string,
  dependencyName: string,
  metadataName = dependencyName,
): Promise<string> {
  let metadata: string;
  try {
    metadata = createRequire(join(fromRoot, "package.json")).resolve(`${dependencyName}/package.json`);
  } catch (error) {
    throw new Error(`Bundled runtime dependency를 찾지 못했습니다: ${dependencyName}`, { cause: error });
  }
  await packageDocument(metadata, metadataName);
  return await realpath(dirname(metadata));
}

function codexPlatform(): { readonly packageName: string; readonly target: string; readonly binary: string } {
  const key = `${process.platform}-${process.arch}`;
  const mapping: Readonly<Record<string, { packageName: string; target: string; binary: string }>> = {
    "darwin-arm64": {
      packageName: "@openai/codex-darwin-arm64",
      target: "aarch64-apple-darwin",
      binary: "codex",
    },
    "darwin-x64": {
      packageName: "@openai/codex-darwin-x64",
      target: "x86_64-apple-darwin",
      binary: "codex",
    },
    "linux-arm64": {
      packageName: "@openai/codex-linux-arm64",
      target: "aarch64-unknown-linux-musl",
      binary: "codex",
    },
    "linux-x64": {
      packageName: "@openai/codex-linux-x64",
      target: "x86_64-unknown-linux-musl",
      binary: "codex",
    },
    "win32-arm64": {
      packageName: "@openai/codex-win32-arm64",
      target: "aarch64-pc-windows-msvc",
      binary: "codex.exe",
    },
    "win32-x64": {
      packageName: "@openai/codex-win32-x64",
      target: "x86_64-pc-windows-msvc",
      binary: "codex.exe",
    },
  };
  const selected = mapping[key];
  if (!selected) throw new Error(`현재 platform의 Codex runtime을 지원하지 않습니다: ${key}`);
  return selected;
}

function musl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report.getReport() as { readonly header?: { readonly glibcVersionRuntime?: unknown } };
  const header = report.header;
  return typeof header?.glibcVersionRuntime !== "string";
}

function claudePlatformPackage(): string {
  const architecture = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
  if (!architecture || !new Set(["darwin", "linux", "win32"]).has(process.platform)) {
    throw new Error(`현재 platform의 Claude runtime을 지원하지 않습니다: ${process.platform}-${process.arch}`);
  }
  const suffix = process.platform === "linux" && musl() ? "-musl" : "";
  return `@anthropic-ai/claude-agent-sdk-${process.platform}-${architecture}${suffix}`;
}

async function requireRegularFile(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label}가 regular file이 아닙니다`);
  return canonical;
}

async function layout(runtimeId: BundledSubscriptionRuntimeId): Promise<RuntimeLayout> {
  if (!BUNDLED_RUNTIME_IDS.has(runtimeId)) {
    throw new Error(`지원하지 않는 Bundled subscription runtime입니다: ${runtimeId}`);
  }
  const sdkName = packageName(runtimeId);
  const sdkEntry = fileURLToPath(import.meta.resolve(sdkName));
  const sdkRoot = await findPackageRoot(sdkEntry, sdkName);
  const sdk = await packageDocument(join(sdkRoot, "package.json"), sdkName);
  if (runtimeId === "codex") {
    const cliRoot = await dependencyRoot(sdkRoot, "@openai/codex");
    const platform = codexPlatform();
    // Codex platform package는 npm alias이고 package.json의 실제 name은 @openai/codex입니다.
    const platformRoot = await dependencyRoot(cliRoot, platform.packageName, "@openai/codex");
    const cli = await requireRegularFile(join(cliRoot, "bin", "codex.js"), "Codex CLI 진입점");
    await requireRegularFile(
      join(platformRoot, "vendor", platform.target, "bin", platform.binary),
      "Codex native binary",
    );
    const node = await requireRegularFile(process.execPath, "Node.js runtime");
    return {
      runtimeId,
      version: sdk.version,
      roots: [
        { label: sdkName, path: sdkRoot },
        { label: "@openai/codex", path: cliRoot },
        { label: platform.packageName, path: platformRoot },
      ],
      files: [{ label: "node-runtime", path: node }],
      command: node,
      commandArguments: [cli],
    };
  }
  const platformName = claudePlatformPackage();
  const platformRoot = await dependencyRoot(sdkRoot, platformName);
  const executable = await requireRegularFile(
    join(platformRoot, process.platform === "win32" ? "claude.exe" : "claude"),
    "Claude native binary",
  );
  return {
    runtimeId,
    version: sdk.version,
    roots: [
      { label: sdkName, path: sdkRoot },
      { label: platformName, path: platformRoot },
    ],
    files: [],
    command: executable,
    commandArguments: [],
  };
}

async function updateFile(hash: Hash, label: string, path: string): Promise<number> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("Bundled runtime artifact file이 유효하지 않습니다");
  hash.update(label).update("\0").update(String(metadata.size)).update("\0");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  hash.update("\0");
  return metadata.size;
}

async function updateTree(hash: Hash, label: string, root: string): Promise<{ files: number; bytes: number }> {
  const canonicalRoot = await realpath(root);
  let files = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      const canonical = await realpath(path);
      if (canonical !== path && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
        throw new Error("Bundled runtime artifact가 package root를 벗어났습니다");
      }
      if (entry.isSymbolicLink()) throw new Error("Bundled runtime artifact 내부 symlink는 허용하지 않습니다");
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error("Bundled runtime artifact에 특수 파일이 있습니다");
      files += 1;
      bytes += await updateFile(hash, `${label}/${relative(canonicalRoot, path).replaceAll(sep, "/")}`, path);
      if (files > MAXIMUM_ARTIFACT_FILES || bytes > MAXIMUM_ARTIFACT_BYTES) {
        throw new Error("Bundled runtime artifact 검사 상한을 초과했습니다");
      }
    }
  };
  await visit(resolve(canonicalRoot));
  return { files, bytes };
}

export async function inspectBundledSubscriptionRuntime(
  runtimeId: BundledSubscriptionRuntimeId,
): Promise<BundledSubscriptionRuntimeArtifact> {
  const selected = await layout(runtimeId);
  const hash = createHash("sha256");
  hash.update("massion-bundled-subscription-runtime-v1\0").update(selected.runtimeId).update("\0");
  let files = 0;
  let bytes = 0;
  for (const root of selected.roots) {
    const measured = await updateTree(hash, root.label, root.path);
    files += measured.files;
    bytes += measured.bytes;
  }
  for (const file of selected.files) {
    files += 1;
    bytes += await updateFile(hash, file.label, file.path);
  }
  hash.update(String(files)).update("\0").update(String(bytes));
  return {
    runtimeId: selected.runtimeId,
    version: selected.version,
    runtimeArtifactDigest: hash.digest("hex"),
    command: selected.command,
    commandArguments: selected.commandArguments,
  };
}
