import { describe, expect, it } from "vitest";

import { validateDocumentSecurity } from "./security.js";

function safe(value: string = "운영 절차를 확인합니다"): Record<string, unknown> {
  return { title: "안전한 문서", sourceReferenceIds: ["source-1"], content: value };
}

describe("Records document security boundary", () => {
  it.each([
    ["상위 경로", "../secrets/config"],
    ["POSIX 절대 경로", "/Users/example/.ssh/id_ed25519"],
    ["서버 절대 경로", "/srv/massion/secrets.env"],
    ["Windows 절대 경로", "C:\\Users\\example\\secret.txt"],
    ["file URI", "file:///etc/passwd"],
    ["javascript URI", "javascript:alert(1)"],
    ["private key", "-----BEGIN PRIVATE KEY-----\nsecret"],
    ["bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
    ["connection string", "postgresql://admin:password@db.internal/app"],
    ["HTTP credential URI", "https://admin:password@example.com/private"],
    ["raw HTML", "<script>alert('x')</script>"],
  ])("%s를 거부한다", (_name, value) => {
    expect(() => validateDocumentSecurity(safe(value))).toThrow();
  });

  it("1 MiB document와 100개 초과 reference를 거부한다", () => {
    expect(() => validateDocumentSecurity(safe("x".repeat(1_048_577)))).toThrow("1 MiB");
    expect(() =>
      validateDocumentSecurity({
        ...safe(),
        sourceReferenceIds: Array.from({ length: 101 }, (_, index) => `source-${index}`),
      }),
    ).toThrow("100개");
  });

  it("HTTPS reference와 일반 Markdown 문장을 허용한다", () => {
    expect(() =>
      validateDocumentSecurity({
        ...safe("공식 문서는 https://example.com/docs 를 참고합니다."),
        sourceReferenceIds: ["source-1", "source-2"],
      }),
    ).not.toThrow();
  });
});
