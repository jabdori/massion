import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";
import type {
  TrustedAssuranceInspectionExecutionInput,
  TrustedAssuranceInspectionExecutionResult,
  TrustedAssuranceInspectionExecutor,
} from "@massion/assurance";

import {
  normalizedSoftwareFileChanges,
  verifySoftwareAssuranceSource,
  type SoftwareAssuranceSourceReader,
} from "./assurance-adapter.js";
import { GitWorkspaceManager } from "./git-workspace.js";

const INSPECTOR_PROFILE = "massion.software-security-scan.v1";

export interface SoftwareSecurityDiffFinding {
  readonly category: "security";
  readonly severity: "major" | "minor";
  readonly message: string;
  readonly sourceRule: "embedded-secret" | "dynamic-evaluation" | "shell-execution" | "shell-true";
  readonly location?: { readonly uri: string; readonly line: number };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safePath(value: string): string | undefined {
  if (!value || value.length > 1_000 || value.includes("\0") || value.split("/").includes("..")) return undefined;
  return value;
}

function findingsForLine(
  line: string,
  location: SoftwareSecurityDiffFinding["location"],
): SoftwareSecurityDiffFinding[] {
  const findings: SoftwareSecurityDiffFinding[] = [];
  const add = (
    sourceRule: SoftwareSecurityDiffFinding["sourceRule"],
    severity: SoftwareSecurityDiffFinding["severity"],
    message: string,
  ): void => {
    findings.push({ category: "security", severity, message, sourceRule, ...(location ? { location } : {}) });
  };
  if (
    /(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|access[_-]?token|secret|password)\s*(?::|=)\s*["'`][^"'`]{8,})/iu.test(
      line,
    )
  ) {
    add("embedded-secret", "major", "변경 코드에 비밀값처럼 보이는 상수가 포함되어 있습니다");
  }
  if (/\b(?:eval|Function)\s*\(/u.test(line)) {
    add("dynamic-evaluation", "major", "변경 코드에 동적 코드 실행이 포함되어 있습니다");
  }
  if (/\b(?:exec|execSync)\s*\(/u.test(line)) {
    add("shell-execution", "minor", "변경 코드에 shell 명령 실행이 포함되어 있습니다");
  }
  if (/\bshell\s*:\s*true\b/u.test(line)) {
    add("shell-true", "major", "변경 코드가 shell 해석을 명시적으로 활성화합니다");
  }
  return findings;
}

/** 변경된 추가 행만 검사해 patch 원문을 저장하지 않는 기본 보안 검사입니다. */
export function scanSoftwareSecurityDiff(diff: string): readonly SoftwareSecurityDiffFinding[] {
  if (diff.length > 4 * 1024 * 1024) return [];
  const findings: SoftwareSecurityDiffFinding[] = [];
  const seen = new Set<string>();
  let uri: string | undefined;
  let lineNumber: number | undefined;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++ ")) {
      uri = line.startsWith("+++ b/") ? safePath(line.slice("+++ b/".length)) : undefined;
      lineNumber = undefined;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const location = uri && lineNumber !== undefined ? { uri, line: lineNumber } : undefined;
      for (const finding of findingsForLine(line.slice(1), location)) {
        const key = `${finding.sourceRule}:${finding.location?.uri ?? ""}:${String(finding.location?.line ?? "")}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push(finding);
        }
      }
      if (lineNumber !== undefined) lineNumber += 1;
      continue;
    }
    if (line.startsWith(" ") && lineNumber !== undefined) lineNumber += 1;
  }
  return findings.slice(0, 100);
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

function blocked(
  input: TrustedAssuranceInspectionExecutionInput,
  category: string,
): TrustedAssuranceInspectionExecutionResult {
  const artifactVersionIds = [...input.artifactVersionIds].sort();
  const evidenceBriefIds = [...input.evidenceBriefIds].sort();
  return {
    status: "blocked",
    outputHash: hash({ category, artifactVersionIds, evidenceBriefIds }),
    summary: "변경 코드 기본 보안 검사를 실행할 수 없습니다",
    evidenceReferenceIds: [...artifactVersionIds, ...evidenceBriefIds],
    artifactVersionIds,
    evidenceBriefIds,
    metricObservationIds: [],
    humanAttestationIds: [],
    findings: [],
  };
}

export class SoftwareSecurityInspectionExecutor implements TrustedAssuranceInspectionExecutor {
  public readonly inspectorProfile = INSPECTOR_PROFILE;

  private constructor(
    private readonly reader: SoftwareAssuranceSourceReader,
    private readonly workspaces: GitWorkspaceManager,
  ) {}

  public static async create(
    reader: SoftwareAssuranceSourceReader,
    input: { readonly workspaceRoot: string },
  ): Promise<SoftwareSecurityInspectionExecutor> {
    return new SoftwareSecurityInspectionExecutor(reader, await GitWorkspaceManager.create({ workspaceRoot: input.workspaceRoot }));
  }

  public async execute(
    context: TenantContext,
    input: TrustedAssuranceInspectionExecutionInput,
  ): Promise<TrustedAssuranceInspectionExecutionResult> {
    if (input.binding.inspectorProfile !== this.inspectorProfile || input.artifactVersionIds.length !== 1) {
      return blocked(input, "binding_invalid");
    }
    try {
      const artifactVersionId = input.artifactVersionIds[0] ?? "";
      const source = await this.reader.read(context, { workId: input.workId, artifactVersionId });
      const manifest = verifySoftwareAssuranceSource(context, { workId: input.workId, artifactVersionId }, source);
      await this.workspaces.verifyRepositoryRoot(source.repository.rootRef, source.repository.rootRealPathHash);
      const branch = await this.workspaces.inspectDeliveryBranch({
        repositoryRoot: source.repository.rootRef,
        baseRevision: source.delivery.baseRevision,
        deliveryId: source.delivery.deliveryId,
      });
      if (
        !branch ||
        branch.branchRef !== manifest.branchRef ||
        branch.commitSha !== manifest.commitSha ||
        branch.changeSetHash !== manifest.changeSetHash ||
        canonicalJson(normalizedSoftwareFileChanges(branch.fileChanges)) !== canonicalJson(manifest.files)
      ) {
        return blocked(input, "provenance_invalid");
      }
      const diff = await this.workspaces.readCommitDiff({
        repositoryRoot: source.repository.rootRef,
        baseRevision: source.delivery.baseRevision,
        targetRevision: manifest.commitSha,
      });
      const findings = scanSoftwareSecurityDiff(diff).map((finding) => ({
        ...finding,
        evidenceReferenceIds: [...input.artifactVersionIds],
        sourceTool: this.inspectorProfile,
        controlReferences: [...input.controlReferences],
      }));
      const artifactVersionIds = [...input.artifactVersionIds].sort();
      const evidenceBriefIds = [...input.evidenceBriefIds].sort();
      return {
        status: "passed",
        outputHash: hash({
          artifactVersionIds,
          evidenceBriefIds,
          findings: findings.map((finding) => ({
            sourceRule: finding.sourceRule,
            severity: finding.severity,
            location: finding.location,
          })),
        }),
        summary: `변경 코드 기본 보안 검사: ${String(findings.length)}건`,
        evidenceReferenceIds: [...artifactVersionIds, ...evidenceBriefIds],
        artifactVersionIds,
        evidenceBriefIds,
        metricObservationIds: [],
        humanAttestationIds: [],
        findings,
      };
    } catch {
      return blocked(input, "execution_unavailable");
    }
  }
}
