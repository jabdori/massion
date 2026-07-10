import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import type { RepositoryProviderKind } from "./contracts.js";
import type { RepositoryScan, ScanOptions, ScannedFile } from "./scanner.js";
import { RepositoryScanner } from "./scanner.js";

const executeFile = promisify(execFile);

export interface CapturedRepositoryRevision {
  readonly providerKind: Extract<RepositoryProviderKind, "git" | "filesystem">;
  readonly providerRevision: string;
  readonly revision: string;
  readonly dirty: boolean;
  readonly dirtyFingerprint?: string;
  readonly manifestChecksum: string;
  readonly rootRealPath: string;
  readonly rootRealPathHash: string;
  readonly collectorVersion: string;
  readonly scan: RepositoryScan;
}

export interface ManifestDiff {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly { readonly previousPath: string; readonly relativePath: string }[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await executeFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
  });
  return result.stdout.trim();
}

export class RepositoryRevisionCollector {
  public constructor(private readonly scanner: RepositoryScanner) {}

  public async capture(root: string, options: ScanOptions): Promise<CapturedRepositoryRevision> {
    const scan = await this.scanner.scan(root, options);
    const rootRealPath = await realpath(root);
    let topLevelOutput: string;
    try {
      topLevelOutput = await git(rootRealPath, ["rev-parse", "--show-toplevel"]);
    } catch {
      const providerRevision = `snapshot:${scan.manifestChecksum}`;
      return {
        providerKind: "filesystem",
        providerRevision,
        revision: providerRevision,
        dirty: false,
        manifestChecksum: scan.manifestChecksum,
        rootRealPath,
        rootRealPathHash: scan.rootRealPathHash,
        collectorVersion: "filesystem-manifest-v1",
        scan,
      };
    }
    const topLevel = await realpath(topLevelOutput);
    if (topLevel !== rootRealPath) throw new Error("Git repository root와 등록 root가 일치하지 않습니다");
    const providerRevision = await git(rootRealPath, ["rev-parse", "HEAD"]);
    const status = await git(rootRealPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const dirty = status.length > 0;
    const dirtyFingerprint = dirty ? sha256(`${status}\0${scan.manifestChecksum}`) : undefined;
    return {
      providerKind: "git",
      providerRevision,
      revision: dirty ? `${providerRevision}:dirty:${dirtyFingerprint ?? ""}` : providerRevision,
      dirty,
      ...(dirtyFingerprint ? { dirtyFingerprint } : {}),
      manifestChecksum: scan.manifestChecksum,
      rootRealPath,
      rootRealPathHash: scan.rootRealPathHash,
      collectorVersion: "git-manifest-v1",
      scan,
    };
  }
}

export function diffManifests(before: readonly ScannedFile[], after: readonly ScannedFile[]): ManifestDiff {
  const beforeByPath = new Map(before.map((file) => [file.relativePath, file]));
  const afterByPath = new Map(after.map((file) => [file.relativePath, file]));
  const createdCandidates = [...afterByPath.keys()].filter((item) => !beforeByPath.has(item)).sort();
  const deletedCandidates = [...beforeByPath.keys()].filter((item) => !afterByPath.has(item)).sort();
  const modified = [...beforeByPath.keys()]
    .filter(
      (item) => beforeByPath.get(item)?.contentHash !== afterByPath.get(item)?.contentHash && afterByPath.has(item),
    )
    .sort();
  const created = new Set(createdCandidates);
  const deleted = new Set(deletedCandidates);
  const renamed: { previousPath: string; relativePath: string }[] = [];
  for (const previousPath of deletedCandidates) {
    const contentHash = beforeByPath.get(previousPath)?.contentHash;
    const relativePath = createdCandidates.find(
      (candidate) => created.has(candidate) && afterByPath.get(candidate)?.contentHash === contentHash,
    );
    if (!relativePath) continue;
    deleted.delete(previousPath);
    created.delete(relativePath);
    renamed.push({ previousPath, relativePath });
  }
  return {
    created: [...created].sort(),
    modified,
    deleted: [...deleted].sort(),
    renamed: renamed.sort((left, right) => left.previousPath.localeCompare(right.previousPath)),
  };
}
