import { describe, expect, it } from "vitest";

import { classifyFailure, parseRetryAfter, type FailureSignal } from "./failure.js";

describe("Provider 실패 분류", () => {
  it.each<[FailureSignal, string, boolean]>([
    [{ kind: "http", statusCode: 401 }, "authentication", true],
    [{ kind: "http", statusCode: 402 }, "billing", false],
    [{ kind: "http", statusCode: 403 }, "policy", false],
    [{ kind: "http", statusCode: 408 }, "timeout", true],
    [{ kind: "http", statusCode: 409 }, "upstream", true],
    [{ kind: "http", statusCode: 429 }, "quota", true],
    [{ kind: "http", statusCode: 503 }, "upstream", true],
    [{ kind: "http", statusCode: 400 }, "input", false],
    [{ kind: "timeout" }, "timeout", true],
    [{ kind: "network" }, "network", true],
    [{ kind: "input" }, "input", false],
    [{ kind: "policy" }, "policy", false],
    [{ kind: "cancelled" }, "cancelled", false],
    [{ kind: "unknown" }, "unknown", false],
  ])("$signal을 $failureClass로 분류한다", (signal, failureClass, fallbackEligible) => {
    expect(classifyFailure(signal)).toMatchObject({ failureClass, fallbackEligible });
  });

  it("Retry-After의 초와 HTTP date를 절대 시각으로 변환한다", () => {
    const now = Date.parse("2030-01-01T00:00:00Z");
    expect(parseRetryAfter("60", now)).toBe("2030-01-01T00:01:00.000Z");
    expect(parseRetryAfter("Tue, 01 Jan 2030 00:02:00 GMT", now)).toBe("2030-01-01T00:02:00.000Z");
    expect(parseRetryAfter("invalid", now)).toBeUndefined();
  });
});
