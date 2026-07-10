import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import type { AgentExecutionResult, StructuredAgentRunner } from "@massion/runtime";
import { createDatabase } from "@massion/storage";

import {
  DatabaseStructuredInspectionEvidenceLoader,
  executeStructuredInspection,
  StructuredAssuranceInspectionExecutor,
} from "./inspection.js";

const context = {
  organizationId: "organization-1",
  userId: "user-1",
  membershipId: "membership-1",
  role: "owner",
} as TenantContext;

const input = {
  commandId: "inspection-command-1",
  workId: "work-1",
  assuranceRunId: "run-1",
  criterionId: "criterion-1",
  agentHandle: "assurance",
  modelRoute: "assurance:inspection",
  correlationId: "correlation-1",
  inspectorProfile: "massion.inspection.security.v1",
  evidence: [
    {
      evidenceReferenceId: "artifact-1",
      kind: "sarif",
      checksum: "a".repeat(64),
      summary: "정적 분석 결과 1건",
    },
  ],
  evidenceReferenceAllowlist: ["artifact-1"],
  controlReferenceAllowlist: ["OWASP-ASVS-5.0.0"],
  maximumFindings: 10,
  estimatedTokens: 1_000,
  estimatedCostMicros: 100,
} as const;

function runner(result: AgentExecutionResult): StructuredAgentRunner {
  return { executeStructured: vi.fn(async () => result) };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Structured model inspection", () => {
  it("JSON schema finding만 기존 evidence·control allowlist에 결속하고 verdict는 서버가 보유한다", async () => {
    const structured = runner({
      executionId: "execution-1",
      status: "succeeded",
      output: {
        findings: [
          {
            category: "security",
            severity: "major",
            message: "인증 경로에서 권한 검사가 누락됐습니다",
            location: { uri: "src/auth.ts", line: 42, column: 3 },
            evidenceReferenceIds: ["artifact-1"],
            sourceRule: "MODEL-AUTHZ-001",
            controlReferences: ["OWASP-ASVS-5.0.0"],
          },
        ],
      },
    });

    const actual = await executeStructuredInspection(structured, context, input);

    expect(actual).toMatchObject({
      status: "passed",
      executionId: "execution-1",
      findings: [
        {
          category: "security",
          severity: "major",
          sourceTool: "massion.inspection.security.v1",
          sourceRule: "MODEL-AUTHZ-001",
          evidenceReferenceIds: ["artifact-1"],
          controlReferences: ["OWASP-ASVS-5.0.0"],
        },
      ],
    });
    expect(actual.outputHash).toMatch(/^[a-f0-9]{64}$/u);
    const spec = vi.mocked(structured.executeStructured).mock.calls[0]?.[2];
    expect(spec?.jsonSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(JSON.stringify(spec?.jsonSchema)).not.toContain("verdict");
  });

  it.each([
    {
      label: "evidence allowlist 밖 reference",
      output: {
        findings: [
          {
            category: "security",
            severity: "major",
            message: "finding",
            evidenceReferenceIds: ["forged-artifact"],
            sourceRule: "RULE-1",
            controlReferences: [],
          },
        ],
      },
    },
    {
      label: "unsupported control conformance",
      output: {
        findings: [
          {
            category: "security",
            severity: "minor",
            message: "finding",
            evidenceReferenceIds: ["artifact-1"],
            sourceRule: "RULE-1",
            controlReferences: ["UNSUPPORTED-CONTROL"],
          },
        ],
      },
    },
    { label: "직접 verdict", output: { verdict: "passed", findings: [] } },
    { label: "conformance 주장", output: { conforms: true, findings: [] } },
    {
      label: "absolute location",
      output: {
        findings: [
          {
            category: "security",
            severity: "minor",
            message: "finding",
            location: { uri: "file:///etc/passwd" },
            evidenceReferenceIds: ["artifact-1"],
            sourceRule: "RULE-1",
            controlReferences: [],
          },
        ],
      },
    },
    {
      label: "secret message",
      output: {
        findings: [
          {
            category: "security",
            severity: "minor",
            message: "api_key='supersecretvalue'",
            evidenceReferenceIds: ["artifact-1"],
            sourceRule: "RULE-1",
            controlReferences: [],
          },
        ],
      },
    },
  ])("invalid model output인 $label은 finding 없이 blocked로 둔다", async ({ output }) => {
    const actual = await executeStructuredInspection(
      runner({ executionId: "execution-invalid", status: "succeeded", output }),
      context,
      input,
    );
    expect(actual).toMatchObject({ status: "blocked", findings: [] });
  });

  it("모델 부재·실패·예외와 finding 상한 초과를 blocked로 둔다", async () => {
    await expect(executeStructuredInspection(undefined, context, input)).resolves.toMatchObject({
      status: "blocked",
      findings: [],
    });
    await expect(
      executeStructuredInspection(
        runner({ executionId: "execution-failed", status: "blocked_model_unavailable" }),
        context,
        input,
      ),
    ).resolves.toMatchObject({ status: "blocked", findings: [] });
    const throwing: StructuredAgentRunner = {
      async executeStructured() {
        throw new Error("provider unavailable");
      },
    };
    await expect(executeStructuredInspection(throwing, context, input)).resolves.toMatchObject({
      status: "blocked",
      findings: [],
    });
    const tooMany = {
      findings: Array.from({ length: 11 }, (_, index) => ({
        category: "security",
        severity: "info",
        message: `finding-${String(index)}`,
        evidenceReferenceIds: ["artifact-1"],
        sourceRule: `RULE-${String(index)}`,
        controlReferences: [],
      })),
    };
    await expect(
      executeStructuredInspection(
        runner({ executionId: "execution-many", status: "succeeded", output: tooMany }),
        context,
        input,
      ),
    ).resolves.toMatchObject({ status: "blocked", findings: [] });
  });

  it("prompt로 전달할 evidence·control allowlist 자체도 bounded exact set으로 제한한다", async () => {
    await expect(
      executeStructuredInspection(undefined, context, {
        ...input,
        evidenceReferenceAllowlist: ["artifact-1", "unused-artifact"],
      }),
    ).rejects.toThrow("정확히 일치");
    await expect(
      executeStructuredInspection(undefined, context, {
        ...input,
        controlReferenceAllowlist: ["OWASP-ASVS-5.0.0", "OWASP-ASVS-5.0.0"],
      }),
    ).rejects.toThrow("중복");
    await expect(
      executeStructuredInspection(undefined, context, {
        ...input,
        controlReferenceAllowlist: Array.from({ length: 51 }, (_, index) => `CONTROL-${String(index)}`),
      }),
    ).rejects.toThrow("상한");
  });

  it("trusted inspection executor가 runner finding을 CheckStore용 단일 결과로 결속한다", async () => {
    const structured = runner({
      executionId: "inspection-execution-1",
      status: "succeeded",
      output: {
        findings: [
          {
            category: "security",
            severity: "major",
            message: "권한 검사가 누락됐습니다",
            evidenceReferenceIds: ["artifact-1"],
            sourceRule: "AUTHZ-001",
            controlReferences: ["OWASP-ASVS-5.0.0"],
          },
        ],
      },
    });
    const executor = new StructuredAssuranceInspectionExecutor(
      structured,
      {
        async load() {
          return input.evidence;
        },
      },
      {
        inspectorProfile: input.inspectorProfile,
        modelRoute: input.modelRoute,
        estimatedTokens: input.estimatedTokens,
        estimatedCostMicros: input.estimatedCostMicros,
      },
    );

    const actual = await executor.execute(context, {
      workId: input.workId,
      assuranceRunId: input.assuranceRunId,
      criterionId: input.criterionId,
      verificationId: input.commandId,
      binding: {
        bindingKey: "inspection:security",
        criterionKey: "security:scan",
        kind: "inspection",
        executor: { kind: "runtime_agent", handle: input.agentHandle },
        inspectorProfile: input.inspectorProfile,
        evidenceAllowlist: ["artifact-version"],
        maximumAgeMs: 60_000,
        maximumFindings: input.maximumFindings,
        requiredEvidenceKinds: ["finding"],
      },
      artifactVersionIds: ["artifact-1"],
      evidenceBriefIds: [],
      controlReferences: ["OWASP-ASVS-5.0.0"],
    });

    expect(actual).toMatchObject({
      status: "passed",
      executionId: "inspection-execution-1",
      artifactVersionIds: ["artifact-1"],
      findings: [{ severity: "major", sourceTool: input.inspectorProfile }],
    });
  });

  it("DB loader가 현재 ready index와 revision이 다른 EvidenceBrief를 거부한다", async () => {
    const database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    try {
      const identity = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identity.registerPersonalUser({ email: "inspection@example.com", displayName: "Inspection" });
      const tenant = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const brief = {
        workId: "work-1",
        repositoryId: "repository-1",
        repositoryRevisionId: "revision-old",
        indexVersionId: "index-old",
        configurationChecksum: "a".repeat(64),
        query: "권한 검사를 찾아주세요",
        status: "ready",
        references: [],
        claims: [{ statement: "권한 검사가 필요합니다" }],
      } as const;
      await database.query(
        "CREATE evidence_brief CONTENT { evidence_brief_id: 'brief-1', organization_id: $organization_id, work_id: $work_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, index_version_id: $index_version_id, configuration_checksum: $configuration_checksum, query: $query, status: $status, references_json: $references_json, claims_json: $claims_json, checksum: $checksum, created_by_user_id: $user_id, created_at: time::now() }; CREATE index_version CONTENT { organization_id: $organization_id, repository_id: $repository_id, repository_revision_id: 'revision-current', index_version_id: 'index-current', configuration_checksum: $configuration_checksum, current: true, status: 'ready' };",
        {
          organization_id: tenant.organizationId,
          work_id: brief.workId,
          repository_id: brief.repositoryId,
          repository_revision_id: brief.repositoryRevisionId,
          index_version_id: brief.indexVersionId,
          configuration_checksum: brief.configurationChecksum,
          query: brief.query,
          status: brief.status,
          references_json: JSON.stringify(brief.references),
          claims_json: JSON.stringify(brief.claims),
          checksum: sha256(canonicalJson(brief)),
          user_id: tenant.userId,
        },
      );
      const loader = new DatabaseStructuredInspectionEvidenceLoader(database, organizations);

      await expect(
        loader.load(tenant, {
          workId: brief.workId,
          assuranceRunId: "run-1",
          criterionId: "criterion-1",
          verificationId: "verification-1",
          binding: {
            bindingKey: "inspection:security",
            criterionKey: "security:scan",
            kind: "inspection",
            executor: { kind: "runtime_agent", handle: "security-review" },
            inspectorProfile: "massion.inspection.security.v1",
            evidenceAllowlist: ["evidence-brief"],
            maximumAgeMs: 60_000,
            maximumFindings: 10,
            requiredEvidenceKinds: ["finding"],
          },
          artifactVersionIds: [],
          evidenceBriefIds: ["brief-1"],
          controlReferences: [],
        }),
      ).rejects.toThrow("repository revision");
    } finally {
      await database.close();
    }
  });
});
