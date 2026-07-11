import { createHash } from "node:crypto";

import { validateExtensionManifest, type ExtensionManifestV1 } from "@massion/extension-sdk";
import semver from "semver";
import { Parser, type ReadEntry } from "tar";

import type { ExtensionArtifactFile, ExtensionArtifactReport, ExtensionRuntimeVersions } from "./contracts.js";
import {
  assertNoEmbeddedCredential,
  assertSafeArchivePath,
  assertSafeExtensionFile,
  validatePackageSecurity,
} from "./security.js";

export interface InspectExtensionArchiveOptions {
  readonly runtime: ExtensionRuntimeVersions;
  readonly limits?: {
    readonly maxArchiveBytes?: number;
    readonly maxUnpackedBytes?: number;
    readonly maxEntries?: number;
    readonly maxFileBytes?: number;
  };
}

interface CapturedEntry {
  readonly path: string;
  readonly mode: number;
  readonly body: Buffer;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
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

function checkCompatibility(manifest: ExtensionManifestV1, runtime: ExtensionRuntimeVersions): void {
  const pairs: readonly [string, string | undefined, string][] = [
    [manifest.compatibility.agentOS, runtime.agentOS, "AgentOS"],
    [manifest.compatibility.node, runtime.node, "Node.js"],
    [manifest.compatibility.surrealDB ?? "*", runtime.surrealDB, "SurrealDB"],
  ];
  for (const [range, version, label] of pairs) {
    if (!semver.validRange(range)) throw new Error(`${label} 호환 범위가 유효하지 않습니다`);
    if (version !== undefined && !semver.satisfies(version, range, { includePrerelease: false })) {
      throw new Error(`${label} runtime version이 Extension 호환 범위를 벗어났습니다`);
    }
  }
}

async function readEntries(
  archive: Buffer,
  limits: Required<NonNullable<InspectExtensionArchiveOptions["limits"]>>,
): Promise<readonly CapturedEntry[]> {
  const entries: CapturedEntry[] = [];
  const paths = new Set<string>();
  let unpacked = 0;
  return await new Promise<readonly CapturedEntry[]>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const parser = new Parser({
      strict: true,
      maxMetaEntrySize: 64 * 1024,
      maxDecompressionRatio: 100,
      onReadEntry(entry: ReadEntry) {
        try {
          const path = assertSafeArchivePath(entry.path);
          if (entry.type === "SymbolicLink" || entry.type === "Link") {
            throw new Error(`Extension archive link를 허용하지 않습니다: ${path}`);
          }
          if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "Directory") {
            throw new Error(`Extension archive entry type을 허용하지 않습니다: ${entry.type}`);
          }
          if (entry.type === "Directory") {
            entry.resume();
            return;
          }
          assertSafeExtensionFile(path);
          const collisionKey = path.normalize("NFC").toLocaleLowerCase("en-US");
          if (paths.has(collisionKey)) throw new Error(`Extension archive normalized path가 중복됐습니다: ${path}`);
          paths.add(collisionKey);
          if (paths.size > limits.maxEntries) throw new Error("Extension archive entry 상한을 초과했습니다");
          if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes) {
            throw new Error(`Extension archive file byte 상한을 초과했습니다: ${path}`);
          }
          unpacked += entry.size;
          if (unpacked > limits.maxUnpackedBytes)
            throw new Error("Extension archive 압축 해제 byte 상한을 초과했습니다");
          const chunks: Buffer[] = [];
          let actual = 0;
          entry.on("data", (chunk: Buffer) => {
            actual += chunk.length;
            if (actual > entry.size || actual > limits.maxFileBytes) {
              fail(new Error(`Extension archive file 실제 byte가 header와 다릅니다: ${path}`));
              parser.abort(new Error("Extension archive byte 검증 실패"));
              return;
            }
            chunks.push(chunk);
          });
          entry.on("end", () => {
            if (actual !== entry.size) {
              fail(new Error(`Extension archive file 실제 byte가 header와 다릅니다: ${path}`));
              return;
            }
            const body = Buffer.concat(chunks);
            try {
              assertNoEmbeddedCredential(path, body);
              entries.push({ path, mode: entry.mode ?? 0, body });
            } catch (error) {
              fail(error);
            }
          });
          entry.on("error", fail);
        } catch (error) {
          fail(error);
          parser.abort(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    parser.on("error", fail);
    parser.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(entries);
    });
    parser.end(archive);
  });
}

export async function inspectExtensionArchive(
  archive: Buffer,
  options: InspectExtensionArchiveOptions,
): Promise<ExtensionArtifactReport> {
  const limits = {
    maxArchiveBytes: options.limits?.maxArchiveBytes ?? 32 * 1024 * 1024,
    maxUnpackedBytes: options.limits?.maxUnpackedBytes ?? 128 * 1024 * 1024,
    maxEntries: options.limits?.maxEntries ?? 10_000,
    maxFileBytes: options.limits?.maxFileBytes ?? 16 * 1024 * 1024,
  };
  if (archive.length === 0 || archive.length > limits.maxArchiveBytes) {
    throw new Error("Extension archive byte 상한을 초과했습니다");
  }
  const captured = await readEntries(archive, limits);
  const byPath = new Map(captured.map((entry) => [entry.path, entry]));
  const packageEntry = byPath.get("package.json");
  if (!packageEntry) throw new Error("Extension archive에 package.json이 없습니다");
  const packageJson = validatePackageSecurity(parseJson(packageEntry.body, "package.json"));
  const massion = packageJson.massion;
  if (!massion || typeof massion !== "object" || Array.isArray(massion)) {
    throw new Error("package.json massion.manifest가 없습니다");
  }
  const manifestPath = (massion as Record<string, unknown>).manifest;
  if (typeof manifestPath !== "string") throw new Error("package.json massion.manifest가 유효하지 않습니다");
  assertSafeArchivePath(`package/${manifestPath}`);
  const manifestEntry = byPath.get(manifestPath);
  if (!manifestEntry) throw new Error("Extension manifest file이 없습니다");
  const manifest = validateExtensionManifest(parseJson(manifestEntry.body, "Extension manifest"));
  if (packageJson.name !== manifest.name) throw new Error("package와 manifest name이 일치하지 않습니다");
  if (packageJson.version !== manifest.version) throw new Error("package와 manifest version이 일치하지 않습니다");
  if (packageJson.type !== "module") throw new Error("Extension package type은 module이어야 합니다");
  if (!byPath.has(manifest.runtime.entrypoint)) throw new Error("Extension runtime entrypoint file이 없습니다");
  checkCompatibility(manifest, options.runtime);

  const files: ExtensionArtifactFile[] = captured
    .map((entry) => ({ path: entry.path, size: entry.body.length, mode: entry.mode, digest: sha256(entry.body) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    packageJson: structuredClone(packageJson),
    manifest: structuredClone(manifest),
    artifactDigest: sha256(archive),
    contentDigest: sha256(canonicalJson(files)),
    files,
  };
}
