import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase } from "@massion/storage";

import { ingestSarif, SarifAssuranceInspectionExecutor } from "./sarif.js";

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function log(results: readonly unknown[], version = "2.1.0"): unknown {
  return {
    version,
    runs: [
      {
        tool: {
          driver: {
            name: "Massion Scanner",
            version: "1.2.3",
            rules: [{ id: "SEC001" }, { id: "REL002" }],
          },
        },
        results,
      },
    ],
  };
}

const options = (content: Uint8Array) => ({
  artifactVersionId: "artifact-version-1",
  expectedChecksum: checksum(content),
  category: "security" as const,
  maximumBytes: 100_000,
  maximumRuns: 4,
  maximumResults: 20,
});

describe("bounded SARIF 2.1.0 ingestion", () => {
  it("UTF-8 SARIF의 tool·rule·level·repository-relative location을 bounded finding으로 변환한다", () => {
    const content = bytes(
      log([
        {
          ruleId: "SEC001",
          level: "error",
          message: { text: "취약한 검증 경로입니다" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/auth.ts", uriBaseId: "SRCROOT" },
                region: { startLine: 12, startColumn: 3 },
              },
            },
          ],
        },
        {
          rule: { index: 1 },
          level: "warning",
          message: { text: "복구 경로를 확인하세요" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/recovery.ts" } } }],
        },
      ]),
    );

    const ingested = ingestSarif(content, options(content));

    expect(ingested).toMatchObject({
      artifactVersionId: "artifact-version-1",
      artifactChecksum: checksum(content),
      runCount: 1,
      resultCount: 2,
      findings: [
        {
          category: "security",
          severity: "major",
          sourceTool: "Massion Scanner",
          sourceRule: "SEC001",
          message: "취약한 검증 경로입니다",
          location: { uri: "src/auth.ts", line: 12, column: 3 },
          evidenceReferenceIds: ["artifact-version-1"],
        },
        {
          severity: "minor",
          sourceRule: "REL002",
          location: { uri: "src/recovery.ts" },
        },
      ],
    });
    expect(ingested.outputHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    { label: "2.2 draft", value: log([], "2.2.0") },
    { label: "runs 누락", value: { version: "2.1.0" } },
    {
      label: "absolute URI",
      value: log([
        {
          ruleId: "SEC001",
          message: { text: "x" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "file:///etc/passwd" } } }],
        },
      ]),
    },
    {
      label: "traversal URI",
      value: log([
        {
          ruleId: "SEC001",
          message: { text: "x" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/%2e%2e/secret" } } }],
        },
      ]),
    },
    {
      label: "backslash URI",
      value: log([
        {
          ruleId: "SEC001",
          message: { text: "x" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src\\secret.ts" } } }],
        },
      ]),
    },
    { label: "unknown rule", value: log([{ rule: { index: 99 }, message: { text: "x" } }]) },
    { label: "unknown level", value: log([{ ruleId: "SEC001", level: "fatal", message: { text: "x" } }]) },
  ])("$label 입력을 거부한다", ({ value }) => {
    const content = bytes(value);
    expect(() => ingestSarif(content, options(content))).toThrow();
  });

  it("invalid UTF-8, checksum 변조, byte·run·result 상한과 secret output을 거부한다", () => {
    const invalidUtf8 = Uint8Array.from([0xff, 0xfe, 0xfd]);
    expect(() =>
      ingestSarif(invalidUtf8, { ...options(invalidUtf8), expectedChecksum: checksum(invalidUtf8) }),
    ).toThrow("UTF-8");

    const valid = bytes(log([]));
    expect(() => ingestSarif(valid, { ...options(valid), expectedChecksum: "0".repeat(64) })).toThrow("checksum");
    expect(() => ingestSarif(valid, { ...options(valid), maximumBytes: valid.byteLength - 1 })).toThrow("byte");

    const tooManyRuns = bytes({ version: "2.1.0", runs: [log([]), log([])] });
    expect(() => ingestSarif(tooManyRuns, { ...options(tooManyRuns), maximumRuns: 1 })).toThrow("run");

    const tooManyResults = bytes(
      log([
        { ruleId: "SEC001", message: { text: "a" } },
        { ruleId: "SEC001", message: { text: "b" } },
      ]),
    );
    expect(() => ingestSarif(tooManyResults, { ...options(tooManyResults), maximumResults: 1 })).toThrow("result");

    const secret = bytes(log([{ ruleId: "SEC001", message: { text: "api_key='supersecretvalue'" } }]));
    expect(() => ingestSarif(secret, options(secret))).toThrow("credential");
  });

  it("oversized result message와 line·column 범위 오류를 거부한다", () => {
    const oversized = bytes(log([{ ruleId: "SEC001", message: { text: "x".repeat(4_001) } }]));
    expect(() => ingestSarif(oversized, options(oversized))).toThrow("message");

    const invalidRegion = bytes(
      log([
        {
          ruleId: "SEC001",
          message: { text: "x" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/index.ts" },
                region: { startLine: 0, startColumn: -1 },
              },
            },
          ],
        },
      ]),
    );
    expect(() => ingestSarif(invalidRegion, options(invalidRegion))).toThrow("region");
  });

  it("result 하나의 여러 location도 누적 finding 상한을 우회하지 못한다", () => {
    const content = bytes(
      log([
        {
          ruleId: "SEC001",
          message: { text: "x" },
          locations: [
            { physicalLocation: { artifactLocation: { uri: "src/a.ts" } } },
            { physicalLocation: { artifactLocation: { uri: "src/b.ts" } } },
          ],
        },
      ]),
    );
    expect(() => ingestSarif(content, { ...options(content), maximumResults: 1 })).toThrow("finding 상한");
  });

  it("DB SARIF executor가 CheckStore용 check·finding 결과를 한 payload로 반환한다", async () => {
    const content = bytes(log([{ ruleId: "SEC001", level: "error", message: { text: "권한 우회" } }]));
    const database = {
      async query() {
        return [
          [
            {
              artifact_version_id: "artifact-version-1",
              checksum: checksum(content),
              content_json: new TextDecoder().decode(content),
            },
          ],
        ];
      },
    } as unknown as MassionDatabase;
    const organizations = {
      async verifyTenantContext() {
        return undefined;
      },
    } as unknown as OrganizationService;
    const executor = new SarifAssuranceInspectionExecutor(database, organizations, {
      inspectorProfile: "massion.sarif.v1",
      category: "security",
      maximumBytes: 100_000,
      maximumRuns: 4,
      maximumResults: 20,
      toolVersion: "2.1.0",
    });
    const context = { organizationId: "organization-1", userId: "user-1" } as TenantContext;

    const actual = await executor.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "verification-1",
      binding: {
        bindingKey: "inspection:sarif",
        criterionKey: "security:scan",
        kind: "inspection",
        executor: { kind: "system_adapter", adapterId: "massion.sarif.v1" },
        inspectorProfile: "massion.sarif.v1",
        evidenceAllowlist: ["artifact-version"],
        maximumAgeMs: 60_000,
        maximumFindings: 10,
        requiredEvidenceKinds: ["finding"],
      },
      artifactVersionIds: ["artifact-version-1"],
      evidenceBriefIds: [],
      controlReferences: [],
    });

    expect(actual).toMatchObject({
      status: "passed",
      findings: [{ severity: "major", evidenceReferenceIds: ["artifact-version-1"] }],
    });
  });
});
