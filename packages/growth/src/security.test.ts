import { describe, expect, it } from "vitest";

import { assertGrowthSecurity, validateGrowthSuggestionSecurity } from "./security.js";

describe("Growth security validator", () => {
  it.each([
    "/etc/passwd",
    "../../secrets.env",
    "C:\\Users\\admin\\key.pem",
    "file:///tmp/token",
    "javascript:alert(1)",
    "-----BEGIN PRIVATE KEY-----",
    "Bearer eyJhbGciOiJIUzI1NiJ9.secret",
    "postgres://admin:password@db.internal/product",
    "mongodb+srv://user:pass@cluster.example/db",
  ])("위험 문자열 %s을 거부한다", (value) => {
    expect(() => assertGrowthSecurity(value)).toThrow("Growth 보안");
  });

  it("깊이·operation·byte 상한을 거부한다", () => {
    expect(() => assertGrowthSecurity({ a: { b: { c: { d: true } } } }, { maxDepth: 3 })).toThrow("깊이");
    expect(() => assertGrowthSecurity({ a: 1, b: 2, c: 3 }, { maxOperations: 2 })).toThrow("operation");
    expect(() => assertGrowthSecurity("x".repeat(1025), { maxBytes: 1024 })).toThrow("byte");
  });

  it("Suggestion 256 KiB·source 100개와 Prompt·Memory 1 MiB 경계를 강제한다", () => {
    expect(() =>
      validateGrowthSuggestionSecurity({
        patch: { value: "x" },
        sourceReferenceIds: Array.from({ length: 101 }, (_, index) => `source-${String(index)}`),
      }),
    ).toThrow("source");
    expect(() =>
      validateGrowthSuggestionSecurity({ patch: { value: "x".repeat(256 * 1024) }, sourceReferenceIds: ["source-1"] }),
    ).toThrow("byte");
    expect(() => assertGrowthSecurity("x".repeat(1024 * 1024 + 1), { maxBytes: 1024 * 1024 })).toThrow("byte");
  });
});
