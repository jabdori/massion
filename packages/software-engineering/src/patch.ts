import { createHash } from "node:crypto";

import { normalizeEngineeringPaths } from "./path-lease.js";

const MAX_PATCH_BYTES = 4 * 1024 * 1024;

export interface ValidatedUnifiedPatch {
  readonly text: string;
  readonly sha256: string;
  readonly paths: readonly string[];
  readonly sections: number;
  readonly validated: boolean;
}

function safePath(path: string): string {
  try {
    return normalizeEngineeringPaths([path])[0] ?? "";
  } catch (error) {
    throw new Error(
      `Patch path가 안전한 repository 상대 경로가 아닙니다: ${path}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function parseDiffHeader(line: string): { readonly before: string; readonly after: string } {
  if (!line.startsWith("diff --git a/") || line.startsWith('diff --git "')) {
    throw new Error("지원하지 않는 Git patch header입니다");
  }
  const separator = line.lastIndexOf(" b/");
  if (separator < "diff --git a/".length) throw new Error("Git patch header의 before/after path가 없습니다");
  const before = safePath(line.slice("diff --git a/".length, separator));
  const after = safePath(line.slice(separator + " b/".length));
  return { before, after };
}

function validateFileHeader(line: string, prefix: "--- " | "+++ ", expected: string): void {
  const value = line.slice(prefix.length);
  if (value === "/dev/null") return;
  const gitPrefix = prefix === "--- " ? "a/" : "b/";
  if (!value.startsWith(gitPrefix) || value.includes("\t")) {
    throw new Error(`유효하지 않은 patch header path입니다: ${value}`);
  }
  const path = safePath(value.slice(gitPrefix.length));
  if (path !== expected) throw new Error(`diff header와 patch header path가 다릅니다: ${path}`);
}

function validateModeLine(line: string): void {
  const mode = line.match(/(?:^| )([0-7]{6})$/u)?.[1];
  if (mode === "120000") throw new Error("symlink mode patch는 허용하지 않습니다");
  if (mode === "160000") throw new Error("submodule mode patch는 허용하지 않습니다");
}

export function validateUnifiedPatch(
  text: string,
  options: { readonly allowedPaths: readonly string[] },
): ValidatedUnifiedPatch {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0 || bytes > MAX_PATCH_BYTES) throw new Error("Patch 크기는 1 byte 이상 4 MiB 이하여야 합니다");
  if (text.includes("\0") || !text.endsWith("\n")) throw new Error("Patch는 NUL 없이 newline으로 끝나야 합니다");
  const allowedPaths = normalizeEngineeringPaths(options.allowedPaths);
  const lines = text.split("\n");
  const diffIndexes = lines.flatMap((line, index) => (line.startsWith("diff --git ") ? [index] : []));
  if (diffIndexes.length === 0 || lines.slice(0, diffIndexes[0]).some((line) => line.trim())) {
    throw new Error("Patch는 Git diff section으로만 구성되어야 합니다");
  }

  const paths = new Set<string>();
  for (let sectionIndex = 0; sectionIndex < diffIndexes.length; sectionIndex += 1) {
    const start = diffIndexes[sectionIndex];
    if (start === undefined) continue;
    const end = diffIndexes[sectionIndex + 1] ?? lines.length;
    const header = parseDiffHeader(lines[start] ?? "");
    paths.add(header.before);
    paths.add(header.after);
    let hasChange = false;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    for (const line of lines.slice(start + 1, end)) {
      if (line === "GIT binary patch" || line.startsWith("Binary files ")) {
        throw new Error("binary patch는 허용하지 않습니다");
      }
      if (
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("index ")
      ) {
        validateModeLine(line);
      }
      if (line.startsWith("--- ")) validateFileHeader(line, "--- ", header.before);
      if (line.startsWith("+++ ")) validateFileHeader(line, "+++ ", header.after);
      if (line.startsWith("@@ ") || line.startsWith("@@-")) hasChange = true;
      if (line.startsWith("rename from ")) {
        renameFrom = safePath(line.slice("rename from ".length));
        paths.add(renameFrom);
      }
      if (line.startsWith("rename to ")) {
        renameTo = safePath(line.slice("rename to ".length));
        paths.add(renameTo);
      }
    }
    if (renameFrom || renameTo) {
      if (renameFrom !== header.before || renameTo !== header.after) {
        throw new Error("rename path가 diff header와 일치하지 않습니다");
      }
      hasChange = true;
    }
    if (!hasChange) throw new Error("변경 hunk 또는 rename이 없는 patch section입니다");
  }

  const sortedPaths = [...paths].sort();
  for (const path of sortedPaths) {
    if (!allowedPaths.some((allowed) => allowed === "." || path === allowed || path.startsWith(`${allowed}/`))) {
      throw new Error(`Patch가 허용 경로 밖을 변경합니다: ${path}`);
    }
  }
  return Object.freeze({
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    paths: Object.freeze(sortedPaths),
    sections: diffIndexes.length,
    validated: true as const,
  });
}
