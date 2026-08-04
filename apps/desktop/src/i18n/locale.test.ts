import { describe, expect, it } from "vitest";

import {
  effectiveLocale,
  formatCompactNumber,
  formatDateTime,
  formatNumber,
  languagePreference,
  localeTag,
  normalizeSearch,
  systemLocale,
} from "./locale";

describe("Desktop locale contract", () => {
  it.each([
    ["ko-KR", "ko"],
    ["ko", "ko"],
    ["en-US", "en"],
    ["ja-JP", "en"],
    [undefined, "en"],
  ] as const)("system locale %s를 %s로 해석한다", (language, expected) => {
    expect(systemLocale(language)).toBe(expected);
  });

  it("저장된 en·ko override만 수용하고 system 기본값을 보존한다", () => {
    expect(languagePreference("en")).toBe("en");
    expect(languagePreference("ko")).toBe("ko");
    expect(languagePreference("ja")).toBe("system");
    expect(languagePreference(null)).toBe("system");
    expect(effectiveLocale("ko", "en-US")).toBe("ko");
    expect(effectiveLocale("system", "ko-KR")).toBe("ko");
  });

  it("숫자·날짜·검색을 유효 locale로 처리한다", () => {
    expect(localeTag("en")).toBe("en-US");
    expect(localeTag("ko")).toBe("ko-KR");
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
    expect(formatNumber(1234567, "ko")).toBe("1,234,567");
    expect(formatCompactNumber(100_000_000, "en")).toBe("100M");
    expect(formatCompactNumber(100_000_000, "ko")).toBe("1억");
    expect(formatDateTime("2026-08-03T00:30:00.000Z", "en")).toContain("2026");
    expect(formatDateTime("not-a-date", "ko")).toBe("");
    expect(normalizeSearch("  Ａgent  ", "en")).toBe("agent");
    expect(normalizeSearch("  에이전트  ", "ko")).toBe("에이전트");
  });
});
