import { describe, expect, it } from "vitest";

import { decodeApprovalDisplayPreview, normalizeApprovalDisplayPreview } from "./approval-preview.js";

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f));
  });
}

describe("승인 표시 미리보기", () => {
  it("명령 인수의 민감한 flag·환경 변수·header·URL query 값을 제거한다", () => {
    expect(
      normalizeApprovalDisplayPreview({
        kind: "command",
        title: "명령 실행",
        executable: "curl",
        arguments: [
          "--token",
          "secret-one",
          "API_KEY=secret-two",
          "Authorization: Bearer secret-three",
          "https://example.com/path?password=secret-four&safe=yes",
        ],
        cwd: "/workspace/project",
        reason: "auth_token=secret-five 외부 호출",
      }),
    ).toEqual({
      kind: "command",
      title: "명령 실행",
      executable: "curl",
      arguments: [
        "--token",
        "[민감값 제거]",
        "API_KEY=[민감값 제거]",
        "Authorization: [민감값 제거]",
        "https://example.com/path?password=[민감값 제거]&safe=yes",
      ],
      cwd: "/workspace/project",
      reason: "auth_token=[민감값 제거] 외부 호출",
    });
  });

  it("제어문자와 ANSI sequence를 제거하고 문자열·인수 배열·전체 payload를 제한한다", () => {
    const normalized = normalizeApprovalDisplayPreview({
      kind: "command",
      title: `실행\u001b[31m\u0007 ${"가".repeat(500)}`,
      executable: `node\n${"x".repeat(500)}`,
      arguments: Array.from({ length: 100 }, (_, index) => `${String(index)}-${"나".repeat(500)}`),
      cwd: `/workspace\r${"다".repeat(5_000)}`,
      reason: `사유\t${"라".repeat(5_000)}`,
    });

    expect(hasControlCharacter(normalized.title)).toBe(false);
    expect(hasControlCharacter(normalized.executable)).toBe(false);
    expect(normalized.arguments).toHaveLength(16);
    expect(normalized.arguments.every((argument) => argument.length <= 256)).toBe(true);
    expect(normalized.title.length).toBeLessThanOrEqual(160);
    expect(normalized.cwd?.length).toBeLessThanOrEqual(512);
    expect(normalized.reason?.length).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(JSON.stringify(normalized), "utf8")).toBeLessThanOrEqual(8_192);
  });

  it("파일 변경은 경로·요약만 허용하고 일반 제공자는 제목·이유만 허용한다", () => {
    expect(
      normalizeApprovalDisplayPreview({
        kind: "file-change",
        title: "파일 변경",
        path: "/workspace/src/index.ts",
        summary: "함수 수정",
        reason: "테스트 회귀 해결",
      }),
    ).toEqual({
      kind: "file-change",
      title: "파일 변경",
      path: "/workspace/src/index.ts",
      summary: "함수 수정",
      reason: "테스트 회귀 해결",
    });
    expect(normalizeApprovalDisplayPreview({ kind: "provider", title: "Provider 확인", reason: "권한 확대" })).toEqual({
      kind: "provider",
      title: "Provider 확인",
      reason: "권한 확대",
    });
  });

  it("알 수 없는 필드·중첩 객체·잘못된 kind는 저장 경계에서 거부하고 조회 경계에서는 숨긴다", () => {
    const unsafe = {
      kind: "command",
      title: "실행",
      executable: "git",
      arguments: [],
      rawInput: { password: "never-store" },
    };
    expect(() => normalizeApprovalDisplayPreview(unsafe)).toThrow(/알 수 없는|유효하지/u);
    expect(decodeApprovalDisplayPreview(JSON.stringify(unsafe))).toBeUndefined();
    expect(decodeApprovalDisplayPreview("not-json")).toBeUndefined();
    expect(decodeApprovalDisplayPreview('{"kind":"unknown"}')).toBeUndefined();
  });
});
