import { describe, expect, it } from "vitest";

import { relativeWorkspacePaths } from "./use-desktop-controller";

describe("native workspace path normalization", () => {
  it.each([
    ["POSIX 내부 파일", "/workspace", ["/workspace/src/file.ts"], ["src/file.ts"]],
    ["선택 root 자체", "/workspace", ["/workspace"], undefined],
    ["POSIX root 자체 끝 구분자", "/workspace/", ["/workspace/"], undefined],
    ["밖 또는 접두사만 같은 경로", "/workspace", ["/workspace-other/file.ts"], undefined],
    ["root 끝 구분자", "/workspace/", ["/workspace/src/file.ts"], ["src/file.ts"]],
    ["POSIX 끝 공백", "/workspace ", ["/workspace /file "], ["file "]],
    ["POSIX literal backslash", "/workspace\\name", ["/workspace\\name/file.ts"], ["file.ts"]],
  ])("%s을 보존하거나 거부한다", (_name, root, files, expected) => {
    expect(relativeWorkspacePaths(root, files)).toEqual(expected);
  });
});
