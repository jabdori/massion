import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import createIgnore, { type Ignore } from "ignore";
import { minimatch } from "minimatch";

import { normalizeRepositoryPath, resolveConfinedFile } from "./path.js";

export interface ScanOptions {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly maxFileBytes: number;
}

export type ScannedFileStatus = "indexed";

export interface SecretRedaction {
  readonly startByte: number;
  readonly endByte: number;
  readonly reason: "private_key" | "provider_token" | "credential_assignment";
  readonly contentHash: string;
}

export interface ScannedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly language: string;
  readonly size: number;
  readonly contentHash: string;
  readonly content: string;
  readonly status: ScannedFileStatus;
  readonly redactions: readonly SecretRedaction[];
}

export interface ExcludedFile {
  readonly relativePath: string;
  readonly size?: number;
  readonly contentHash?: string;
  readonly reason: "symlink" | "binary" | "oversized" | "invalid_utf8" | "unsupported";
}

export interface RepositoryScan {
  readonly rootRealPath: string;
  readonly rootRealPathHash: string;
  readonly files: readonly ScannedFile[];
  readonly excluded: readonly ExcludedFile[];
  readonly manifestChecksum: string;
}

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "third_party",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".go": "go",
  ".py": "python",
  ".rs": "rust",
  ".java": "java",
  ".cs": "c_sharp",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".php": "php",
  ".rb": "ruby",
  ".sh": "bash",
  ".bash": "bash",
  ".css": "css",
  ".md": "markdown",
  ".mdx": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".txt": "text",
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function redactSecrets(content: string): {
  readonly content: string;
  readonly redactions: readonly SecretRedaction[];
} {
  const candidates: { start: number; end: number; reason: SecretRedaction["reason"] }[] = [];
  const addMatches = (pattern: RegExp, reason: SecretRedaction["reason"], valueGroup?: number): void => {
    for (const match of content.matchAll(pattern)) {
      const value = valueGroup === undefined ? match[0] : match[valueGroup];
      if (!value) continue;
      const offset = valueGroup === undefined ? 0 : match[0].lastIndexOf(value);
      const start = match.index + offset;
      const end = start + value.length;
      if (candidates.some((candidate) => start < candidate.end && end > candidate.start)) continue;
      candidates.push({ start, end, reason });
    }
  };
  addMatches(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu, "private_key");
  addMatches(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/gu, "provider_token");
  addMatches(
    /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*(["'])([^"'\r\n]{8,})\1/giu,
    "credential_assignment",
    2,
  );
  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  const redactions: SecretRedaction[] = [];
  const output: string[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    output.push(content.slice(cursor, candidate.start));
    const secret = content.slice(candidate.start, candidate.end);
    let replacement = "";
    for (const character of secret) {
      replacement += character === "\n" || character === "\r" ? character : "*".repeat(Buffer.byteLength(character));
    }
    output.push(replacement);
    redactions.push({
      startByte: Buffer.byteLength(content.slice(0, candidate.start)),
      endByte: Buffer.byteLength(content.slice(0, candidate.end)),
      reason: candidate.reason,
      contentHash: sha256(secret),
    });
    cursor = candidate.end;
  }
  output.push(content.slice(cursor));
  return { content: output.join(""), redactions };
}

async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function matches(patterns: readonly string[], relativePath: string): boolean {
  return patterns.some((pattern) => minimatch(relativePath, pattern, { dot: true, matchBase: false }));
}

async function loadIgnore(rootRealPath: string): Promise<Ignore> {
  const rules = createIgnore();
  for (const filename of [".gitignore", ".massionignore"]) {
    try {
      rules.add(await readFile(path.join(rootRealPath, filename), "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return rules;
}

export class RepositoryScanner {
  public async scan(root: string, options: ScanOptions): Promise<RepositoryScan> {
    if (options.include.length === 0) throw new Error("Repository include pattern이 필요합니다");
    if (!Number.isInteger(options.maxFileBytes) || options.maxFileBytes < 1)
      throw new Error("maxFileBytes는 1 이상의 정수여야 합니다");
    const rootRealPath = await realpath(root);
    const rootStat = await stat(rootRealPath);
    if (!rootStat.isDirectory()) throw new Error("Repository root가 directory가 아닙니다");
    const ignore = await loadIgnore(rootRealPath);
    const candidates: string[] = [];
    const symlinks: string[] = [];
    const nonRegular: string[] = [];
    await this.walk(rootRealPath, "", ignore, options, candidates, symlinks, nonRegular);
    candidates.sort((left, right) => left.localeCompare(right));
    symlinks.sort((left, right) => left.localeCompare(right));
    nonRegular.sort((left, right) => left.localeCompare(right));

    const files: ScannedFile[] = [];
    const excluded: ExcludedFile[] = [
      ...symlinks.map((relativePath): ExcludedFile => ({ relativePath, reason: "symlink" })),
      ...nonRegular.map((relativePath): ExcludedFile => ({ relativePath, reason: "unsupported" })),
    ];
    for (const relativePath of candidates) {
      const confined = await resolveConfinedFile(rootRealPath, relativePath);
      const fileStat = await stat(confined.absolutePath);
      const language = LANGUAGE_BY_EXTENSION[path.extname(relativePath).toLowerCase()];
      if (!language) {
        excluded.push({ relativePath, size: fileStat.size, reason: "unsupported" });
        continue;
      }
      if (fileStat.size > options.maxFileBytes) {
        excluded.push({
          relativePath,
          size: fileStat.size,
          contentHash: await hashFile(confined.absolutePath),
          reason: "oversized",
        });
        continue;
      }
      const bytes = await readFile(confined.absolutePath);
      const contentHash = sha256(bytes);
      if (bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)) {
        excluded.push({ relativePath, size: fileStat.size, contentHash, reason: "binary" });
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        excluded.push({ relativePath, size: fileStat.size, contentHash, reason: "invalid_utf8" });
        continue;
      }
      const redacted = redactSecrets(content);
      files.push({
        relativePath,
        absolutePath: confined.absolutePath,
        language,
        size: fileStat.size,
        contentHash,
        content: redacted.content,
        status: "indexed",
        redactions: redacted.redactions,
      });
    }
    excluded.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const manifestChecksum = sha256(
      JSON.stringify({
        files: files.map(({ relativePath, size, contentHash, language, status, redactions }) => ({
          relativePath,
          size,
          contentHash,
          language,
          status,
          redactions,
        })),
        excluded: excluded.map(({ relativePath, size, contentHash, reason }) => ({
          relativePath,
          size,
          contentHash,
          reason,
        })),
      }),
    );
    return {
      rootRealPath,
      rootRealPathHash: sha256(rootRealPath),
      files,
      excluded,
      manifestChecksum,
    };
  }

  private async walk(
    rootRealPath: string,
    relativeDirectory: string,
    ignore: Ignore,
    options: ScanOptions,
    candidates: string[],
    symlinks: string[],
    nonRegular: string[],
  ): Promise<void> {
    const directory = path.join(rootRealPath, ...relativeDirectory.split("/").filter(Boolean));
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = normalizeRepositoryPath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      if (entry.isDirectory()) {
        if (
          DEFAULT_IGNORED_DIRECTORIES.has(entry.name) ||
          ignore.ignores(`${relativePath}/`) ||
          matches(options.exclude, `${relativePath}/`)
        ) {
          continue;
        }
        await this.walk(rootRealPath, relativePath, ignore, options, candidates, symlinks, nonRegular);
        continue;
      }
      if (ignore.ignores(relativePath) || matches(options.exclude, relativePath)) continue;
      if (!matches(options.include, relativePath)) continue;
      if (entry.isSymbolicLink()) {
        symlinks.push(relativePath);
      } else if (entry.isFile()) {
        candidates.push(relativePath);
      } else {
        nonRegular.push(relativePath);
      }
    }
  }
}
