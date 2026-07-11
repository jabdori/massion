import { describe, expect, it } from "vitest";

import { normalizePackageIdentity, transitionVersion } from "./contracts.js";

describe("Registry contracts", () => {
  it("Massion scope와 canonical SemVer만 허용한다", () => {
    expect(normalizePackageIdentity("@massion-ext/github", "1.2.3")).toEqual({
      name: "@massion-ext/github",
      version: "1.2.3",
    });
    expect(() => normalizePackageIdentity("left-pad", "1.0.0")).toThrow("scope");
    expect(() => normalizePackageIdentity("@massion-ext/github", "v1.0.0")).toThrow("SemVer");
  });

  it("staged→published→recalled 단방향 전이만 허용한다", () => {
    expect(transitionVersion("staged", "published")).toBe("published");
    expect(transitionVersion("published", "recalled")).toBe("recalled");
    expect(() => transitionVersion("recalled", "published")).toThrow("상태 전이");
    expect(() => transitionVersion("staged", "recalled")).toThrow("상태 전이");
  });
});
