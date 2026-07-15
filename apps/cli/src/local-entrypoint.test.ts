import { describe, expect, it } from "vitest";

import { defaultLocalEndpoint, ensureLocalEndpoint, shouldEnsureLocalEndpoint } from "./local-entrypoint.js";

describe("local entrypoint preparation", () => {
  it("기본 local port로 loopback endpoint를 만든다", () => {
    expect(defaultLocalEndpoint({ MASSION_LOCAL_PORT: "17431" })).toBe("http://127.0.0.1:17431");
    expect(defaultLocalEndpoint({})).toBe("http://127.0.0.1:7331");
  });

  it("기본 loopback만 자동 시작 대상으로 선택하고 원격 profile은 건너뛴다", () => {
    expect(shouldEnsureLocalEndpoint(undefined, {})).toBe(true);
    expect(shouldEnsureLocalEndpoint("http://127.0.0.1:7331", {})).toBe(true);
    expect(shouldEnsureLocalEndpoint("http://localhost:7331", {})).toBe(true);
    expect(shouldEnsureLocalEndpoint("http://127.0.0.1:17431", { MASSION_LOCAL_PORT: "7331" })).toBe(false);
    expect(shouldEnsureLocalEndpoint("https://massion.example.com", {})).toBe(false);
  });

  it("자동 시작 대상일 때만 server 준비 함수를 한 번 호출한다", async () => {
    const started: string[] = [];
    await expect(
      ensureLocalEndpoint("http://127.0.0.1:7331", {
        environment: {},
        start: async () => {
          started.push("local");
        },
      }),
    ).resolves.toBe(true);
    await expect(
      ensureLocalEndpoint("https://massion.example.com", {
        environment: {},
        start: async () => {
          started.push("remote");
        },
      }),
    ).resolves.toBe(false);
    expect(started).toEqual(["local"]);
  });
});
