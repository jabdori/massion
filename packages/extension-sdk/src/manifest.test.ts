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
    expect(() => validateExtensionManifest({ ...validManifest, description: "가".repeat(70_000) })).toThrow("byte");
    expect(() =>
      validateExtensionManifest({
        ...validManifest,
        permissions: { ...validManifest.permissions, events: Array.from({ length: 257 }, (_, i) => `event.${i}`) },
      }),
    ).toThrow("배열");
  });

  it("모델 평가 번들을 버전·역할·체크섬과 함께 선언할 수 있다", () => {
    const manifest = validateExtensionManifest({
      ...validManifest,
      contributions: {
        ...validManifest.contributions,
        modelEvaluationBundles: [
          {
            id: "software-development-v1",
            roleKey: "software-development",
            version: 1,
            bundleChecksum: "a".repeat(64),
            handler: "evaluation.software-development.v1",
          },
        ],
      },
    });

    expect(manifest.contributions.modelEvaluationBundles).toHaveLength(1);
    expect(manifest.contributions.modelEvaluationBundles?.[0]?.roleKey).toBe("software-development");
  });

  it("모델 평가 번들의 잘못된 체크섬과 중복 식별자를 거부한다", () => {
    const base = {
      ...validManifest,
      contributions: {
        ...validManifest.contributions,
        modelEvaluationBundles: [
          {
            id: "bundle-v1",
            roleKey: "research",
            version: 1,
            bundleChecksum: "b".repeat(64),
            handler: "evaluation.research.v1",
          },
        ],
      },
    };

    expect(() =>
      validateExtensionManifest({
        ...base,
        contributions: {
          ...base.contributions,
          modelEvaluationBundles: [{ ...base.contributions.modelEvaluationBundles[0], bundleChecksum: "bad" }],
        },
      }),
    ).toThrow("체크섬");

    expect(() =>
      validateExtensionManifest({
        ...base,
        contributions: {
          ...base.contributions,
          modelEvaluationBundles: [
            ...base.contributions.modelEvaluationBundles,
            base.contributions.modelEvaluationBundles[0],
          ],
        },
      }),
    ).toThrow("중복");
  });
});
