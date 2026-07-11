import { describe, expect, it } from "vitest";

import { defineExtension, validateExtensionManifest } from "./manifest.js";

const validManifest = {
  schemaVersion: "massion.extension.v1",
  name: "@massion-ext/github",
  version: "1.2.3",
  displayName: "GitHub",
  description: "GitHub 연결 확장",
  license: "Apache-2.0",
  compatibility: { agentOS: ">=1.0.0 <2.0.0", node: ">=24.0.0", surrealDB: ">=3.2.0 <4.0.0" },
  runtime: {
    entrypoint: "dist/worker.js",
    protocol: "massion.extension.rpc.v1",
    healthTimeoutMs: 5_000,
    stopTimeoutMs: 5_000,
  },
  permissions: {
    tools: [{ id: "github.issue.read", operations: ["invoke"] }],
    network: [{ origin: "https://api.github.com", methods: ["GET", "POST"] }],
    files: [{ mount: "repository", access: "read" }],
    secrets: [{ slot: "github-token", purpose: "GitHub API 인증" }],
    process: [],
    mcp: [],
    storage: { quotaBytes: 1_048_576, maxValueBytes: 65_536 },
    events: ["work.completed.v1"],
  },
  contributions: {
    runtimeTools: [{ id: "github.issue.read", handler: "github.issue.read" }],
    organizationTemplates: [],
    growthSignals: [],
    growthTargets: [],
    surfaceConnectors: [],
    eventConsumers: [],
    skills: [],
  },
  uninstall: { retention: "retain" },
} as const;

describe("Extension manifest v1", () => {
  it("정상 manifest를 복제·동결하고 caller 입력을 수정하지 않는다", () => {
    const input = structuredClone(validManifest);
    const manifest = defineExtension(input);

    expect(manifest).toEqual(validManifest);
    expect(manifest).not.toBe(input);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.permissions.network)).toBe(true);
  });

  it.each([
    ["unknown field", { ...validManifest, enabled: true }, "알 수 없는 필드"],
    ["scope name", { ...validManifest, name: "github" }, "@massion-ext"],
    ["SemVer", { ...validManifest, version: "1" }, "SemVer"],
    [
      "entrypoint traversal",
      { ...validManifest, runtime: { ...validManifest.runtime, entrypoint: "../worker.js" } },
      "entrypoint",
    ],
    [
      "wildcard network",
      {
        ...validManifest,
        permissions: {
          ...validManifest.permissions,
          network: [{ origin: "https://*.example.com", methods: ["GET"] }],
        },
      },
      "origin",
    ],
    [
      "raw secret",
      {
        ...validManifest,
        permissions: {
          ...validManifest.permissions,
          secrets: [{ slot: "ghp_12345678901234567890", purpose: "token" }],
        },
      },
      "secret",
    ],
    [
      "duplicate permission",
      {
        ...validManifest,
        permissions: {
          ...validManifest.permissions,
          events: ["work.completed.v1", "work.completed.v1"],
        },
      },
      "중복",
    ],
  ])("%s를 거부한다", (_name, input, message) => {
    expect(() => validateExtensionManifest(input)).toThrow(message);
  });

  it("manifest byte·깊이·배열 상한을 거부한다", () => {
    expect(() =>
      validateExtensionManifest({ ...validManifest, description: "가".repeat(70_000) }),
    ).toThrow("byte");
    expect(() =>
      validateExtensionManifest({
        ...validManifest,
        permissions: { ...validManifest.permissions, events: Array.from({ length: 257 }, (_, i) => `event.${i}`) },
      }),
    ).toThrow("배열");
  });
});
