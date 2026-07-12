import { describe, expect, it } from "vitest";

import { assertSupportedRuntime, isSupportedNodeVersion, parseNodeMajor } from "./runtime.js";

describe("Node.js 런타임 지원 계약", () => {
  it("Node.js major version을 파싱한다", () => {
    expect(parseNodeMajor("v24.8.0")).toBe(24);
    expect(parseNodeMajor("26.1.0")).toBe(26);
  });

  it("잘못된 version 문자열을 거부한다", () => {
    expect(() => parseNodeMajor("latest")).toThrowError("잘못된 Node.js version: latest");
  });

  it("Node.js 23 이하는 지원하지 않는다", () => {
    expect(isSupportedNodeVersion("v23.11.1")).toBe(false);
  });

  it("Node.js 24 이상을 지원한다", () => {
    expect(isSupportedNodeVersion("v24.0.0")).toBe(true);
    expect(isSupportedNodeVersion("v26.1.0")).toBe(true);
  });

  it("지원하지 않는 Runtime에 명확한 오류를 반환한다", () => {
    expect(() => assertSupportedRuntime("v22.22.0")).toThrowError(
      "Massion은 Node.js 24 이상이 필요합니다. 현재: v22.22.0",
    );
  });
});
