import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

export type BuiltinModelRuntimeId = "openai-model";

export interface BuiltinModelRuntimeArtifact {
  readonly runtimeId: BuiltinModelRuntimeId;
  readonly version: string;
  readonly runtimeArtifactDigest: string;
  readonly nodeExecutable: string;
}

interface PackageDocument {
  readonly name?: unknown;
  readonly version?: unknown;
}

const MAXIMUM_FILES = 10_000;
const MAXIMUM_BYTES = 512 * 1024 * 1024;
const localRequire = createRequire(import.meta.url);

async function packageDocument(path: string, expectedName: string): Promise<{ readonly version: string }> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error("내장 모델 runtime package metadata를 읽지 못했습니다", { cause: error });
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("내장 모델 runtime package metadata가 유효하지 않습니다");
  }
  const document = decoded as PackageDocument;
  if (
    document.name !== expectedName ||
    typeof document.version !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u.test(document.version)
  ) {
    throw new Error("내장 모델 runtime package 계보가 일치하지 않습니다");
  }
  return { version: document.version };
}

async function packageRoot(entry: string, expectedName: string): Promise<string> {
  let directory = dirname(await realpath(entry));
  for (;;) {
    const metadata = join(directory, "package.json");
    try {
      await packageDocument(metadata, expectedName);
      return directory;
    } catch (error) {
      const parent = dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
}

async function regularFile(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label}가 regular file이 아닙니다`);
  return canonical;
}

async function updateFile(hash: Hash, label: string, path: string): Promise<number> {
  const canonical = await regularFile(path, label);
  const metadata = await lstat(canonical);
  hash.update(label).update("\0").update(String(metadata.size)).update("\0");
  for await (const chunk of createReadStream(canonical)) hash.update(chunk as Buffer);
  hash.update("\0");
  return metadata.size;
}

async function updateTree(
  hash: Hash,
  label: string,
  root: string,
): Promise<{ readonly files: number; readonly bytes: number }> {
  const canonicalRoot = await realpath(root);
  let files = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("내장 모델 runtime artifact 내부 symlink는 허용하지 않습니다");
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error("내장 모델 runtime artifact에 특수 파일이 있습니다");
      files += 1;
      bytes += await updateFile(hash, `${label}/${relative(canonicalRoot, path).replaceAll(sep, "/")}`, path);
      if (files > MAXIMUM_FILES || bytes > MAXIMUM_BYTES) {
        throw new Error("내장 모델 runtime artifact 검사 상한을 초과했습니다");
      }
    }
  };
  await visit(canonicalRoot);
  return { files, bytes };
}

export async function inspectBuiltinModelRuntime(runtimeId: string): Promise<BuiltinModelRuntimeArtifact> {
  if (runtimeId !== "openai-model") throw new Error(`지원하지 않는 내장 모델 runtime입니다: ${runtimeId}`);

  const runtimeEntry = localRequire.resolve("@massion/runtime");
  const runtimeRoot = await packageRoot(runtimeEntry, "@massion/runtime");
  const runtimePackagePath = await regularFile(join(runtimeRoot, "package.json"), "Massion runtime package metadata");
  const runtimePackage = await packageDocument(runtimePackagePath, "@massion/runtime");
  const runtimeDist = await realpath(join(runtimeRoot, "dist"));
  const runtimeEntryCanonical = await regularFile(runtimeEntry, "Massion runtime 진입점");
  const modelFactory = await regularFile(join(runtimeDist, "model-factory.js"), "직접 모델 팩토리");
  if (!runtimeEntryCanonical.startsWith(`${runtimeDist}${sep}`) || !modelFactory.startsWith(`${runtimeDist}${sep}`)) {
    throw new Error("Massion 직접 모델 runtime artifact 계보가 package 밖을 가리킵니다");
  }

  const runtimeRequire = createRequire(runtimeEntryCanonical);
  const compatibleMetadata = runtimeRequire.resolve("@ai-sdk/openai-compatible/package.json");
  const compatibleRoot = await realpath(dirname(compatibleMetadata));
  const compatiblePackagePath = await regularFile(compatibleMetadata, "OpenAI 호환 SDK package metadata");
  const compatiblePackage = await packageDocument(compatiblePackagePath, "@ai-sdk/openai-compatible");
  const compatibleEntry = await regularFile(
    runtimeRequire.resolve("@ai-sdk/openai-compatible"),
    "OpenAI 호환 SDK 진입점",
  );
  if (!compatibleEntry.startsWith(`${compatibleRoot}${sep}`)) {
    throw new Error("OpenAI 호환 SDK artifact 계보가 package 밖을 가리킵니다");
  }

  const nodeExecutable = await regularFile(process.execPath, "Node.js runtime");
  const hash = createHash("sha256");
  hash.update("massion-builtin-model-runtime-v1\0").update(runtimeId).update("\0");
  let files = 0;
  let bytes = 0;
  for (const [label, path] of [
    ["@massion/runtime/package.json", runtimePackagePath],
    ["@ai-sdk/openai-compatible/package.json", compatiblePackagePath],
    ["node-runtime", nodeExecutable],
  ] as const) {
    files += 1;
    bytes += await updateFile(hash, label, path);
  }
  for (const [label, root] of [
    ["@massion/runtime/dist", runtimeDist],
    ["@ai-sdk/openai-compatible", compatibleRoot],
  ] as const) {
    const measured = await updateTree(hash, label, root);
    files += measured.files;
    bytes += measured.bytes;
  }
  if (files > MAXIMUM_FILES || bytes > MAXIMUM_BYTES) {
    throw new Error("내장 모델 runtime artifact 검사 상한을 초과했습니다");
  }
  hash.update(String(files)).update("\0").update(String(bytes));
  return {
    runtimeId,
    version: `${runtimePackage.version}+openai-compatible.${compatiblePackage.version}`,
    runtimeArtifactDigest: hash.digest("hex"),
    nodeExecutable,
  };
}
