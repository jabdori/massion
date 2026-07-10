import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase } from "@massion/storage";

import type { AssuranceFinding } from "./contracts.js";
import type {
  TrustedAssuranceInspectionExecutionInput,
  TrustedAssuranceInspectionExecutionResult,
  TrustedAssuranceInspectionExecutor,
} from "./checks.js";

export type SarifFindingCategory = AssuranceFinding["category"];
export type SarifFindingSeverity = AssuranceFinding["severity"];

export interface SarifFinding {
  readonly category: SarifFindingCategory;
  readonly severity: SarifFindingSeverity;
  readonly message: string;
  readonly location?: { readonly uri: string; readonly line?: number; readonly column?: number };
  readonly evidenceReferenceIds: readonly string[];
  readonly sourceTool: string;
  readonly sourceRule: string;
  readonly controlReferences: readonly string[];
}

export interface IngestSarifOptions {
  readonly artifactVersionId: string;
  readonly expectedChecksum: string;
  readonly category: SarifFindingCategory;
  readonly maximumBytes: number;
  readonly maximumRuns: number;
  readonly maximumResults: number;
}

export interface IngestedSarif {
  readonly artifactVersionId: string;
  readonly artifactChecksum: string;
  readonly outputHash: string;
  readonly runCount: number;
  readonly resultCount: number;
  readonly findings: readonly SarifFinding[];
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

const LEVELS: Readonly<Record<string, SarifFindingSeverity>> = {
  error: "major",
  warning: "minor",
  note: "info",
  none: "info",
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}는 object여야 합니다`);
  return value as UnknownRecord;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}는 array여야 합니다`);
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}가 필요합니다`);
  if (value.length > maximum) throw new Error(`${label}는 ${String(maximum)}자 이하여야 합니다`);
  return value;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 범위가 올바르지 않습니다`);
  }
}

function validateOptions(options: IngestSarifOptions): void {
  text(options.artifactVersionId, "SARIF ArtifactVersion ID", 200);
  if (!/^[a-f0-9]{64}$/u.test(options.expectedChecksum)) throw new Error("SARIF expected checksum 형식이 잘못됐습니다");
  if (
    !new Set<SarifFindingCategory>(["correctness", "security", "reliability", "operability", "supply-chain"]).has(
      options.category,
    )
  ) {
    throw new Error("SARIF finding category가 올바르지 않습니다");
  }
  boundedInteger(options.maximumBytes, "SARIF byte 상한", 1, 50_000_000);
  boundedInteger(options.maximumRuns, "SARIF run 상한", 1, 100);
  boundedInteger(options.maximumResults, "SARIF result 상한", 1, 100_000);
}

export function containsAssuranceCredential(value: string): boolean {
  return (
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/u.test(value) ||
    /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\r\n]{8,}["']/iu.test(
      value,
    )
  );
}

export function normalizeRepositoryUri(value: unknown, uriBaseId?: unknown): string {
  const raw = text(value, "SARIF artifact URI", 2_000);
  if (uriBaseId !== undefined && uriBaseId !== "SRCROOT") {
    throw new Error("SARIF artifact URI base는 SRCROOT만 허용됩니다");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch (error) {
    throw new Error("SARIF artifact URI percent encoding이 올바르지 않습니다", { cause: error });
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes("?") ||
    decoded.includes("#") ||
    decoded.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)
  ) {
    throw new Error("SARIF artifact URI는 repository-relative path여야 합니다");
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("SARIF artifact URI traversal은 허용되지 않습니다");
  }
  const normalized = posix.normalize(decoded);
  if (normalized !== decoded || normalized.startsWith("../")) {
    throw new Error("SARIF artifact URI가 정규화된 repository-relative path가 아닙니다");
  }
  return normalized;
}

function region(value: unknown): { readonly line?: number; readonly column?: number } {
  if (value === undefined) return {};
  const item = record(value, "SARIF region");
  const line = item.startLine;
  const column = item.startColumn;
  if (line !== undefined && (!Number.isSafeInteger(line) || (line as number) < 1)) {
    throw new Error("SARIF region line 범위가 올바르지 않습니다");
  }
  if (column !== undefined && (!Number.isSafeInteger(column) || (column as number) < 1)) {
    throw new Error("SARIF region column 범위가 올바르지 않습니다");
  }
  return {
    ...(typeof line === "number" ? { line } : {}),
    ...(typeof column === "number" ? { column } : {}),
  };
}

function locations(
  value: unknown,
): readonly ({ readonly uri: string; readonly line?: number; readonly column?: number } | undefined)[] {
  if (value === undefined) return [undefined];
  const entries = array(value, "SARIF result locations");
  if (entries.length === 0) return [undefined];
  if (entries.length > 10) throw new Error("SARIF result location 상한을 초과했습니다");
  return entries.map((entry) => {
    const location = record(entry, "SARIF location");
    const physical = record(location.physicalLocation, "SARIF physical location");
    const artifact = record(physical.artifactLocation, "SARIF artifact location");
    return { uri: normalizeRepositoryUri(artifact.uri, artifact.uriBaseId), ...region(physical.region) };
  });
}

function ruleId(result: UnknownRecord, rules: readonly string[]): string {
  const explicit = result.ruleId === undefined ? undefined : text(result.ruleId, "SARIF rule ID", 200);
  let indexed: string | undefined;
  if (result.rule !== undefined) {
    const rule = record(result.rule, "SARIF result rule");
    if (!Number.isSafeInteger(rule.index) || (rule.index as number) < 0 || (rule.index as number) >= rules.length) {
      throw new Error("SARIF result rule index가 올바르지 않습니다");
    }
    indexed = rules[rule.index as number];
  }
  if (explicit && indexed && explicit !== indexed) throw new Error("SARIF rule ID와 index가 일치하지 않습니다");
  const resolved = explicit ?? indexed;
  if (!resolved) throw new Error("SARIF result rule ID가 필요합니다");
  return resolved;
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

export function ingestSarif(content: Uint8Array, options: IngestSarifOptions): IngestedSarif {
  validateOptions(options);
  if (!(content instanceof Uint8Array)) throw new Error("SARIF content는 UTF-8 byte 배열이어야 합니다");
  if (content.byteLength > options.maximumBytes) throw new Error("SARIF byte 상한을 초과했습니다");
  const artifactChecksum = sha256(content);
  if (artifactChecksum !== options.expectedChecksum) throw new Error("SARIF Artifact checksum이 일치하지 않습니다");
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new Error("SARIF content가 유효한 UTF-8이 아닙니다", { cause: error });
  }
  if (containsAssuranceCredential(raw)) throw new Error("SARIF output에 credential이 포함돼 있습니다");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("SARIF JSON을 해석할 수 없습니다", { cause: error });
  }
  const sarif = record(decoded, "SARIF log");
  if (sarif.version !== "2.1.0") throw new Error("SARIF 2.1.0만 지원합니다");
  const runs = array(sarif.runs, "SARIF runs");
  if (runs.length > options.maximumRuns) throw new Error("SARIF run 상한을 초과했습니다");
  const findings: SarifFinding[] = [];
  let resultCount = 0;
  for (const runValue of runs) {
    const run = record(runValue, "SARIF run");
    const tool = record(run.tool, "SARIF tool");
    const driver = record(tool.driver, "SARIF tool driver");
    const sourceTool = text(driver.name, "SARIF tool name", 200);
    if (driver.version !== undefined) text(driver.version, "SARIF tool version", 200);
    const ruleEntries = driver.rules === undefined ? [] : array(driver.rules, "SARIF driver rules");
    if (ruleEntries.length > 100_000) throw new Error("SARIF rule 상한을 초과했습니다");
    const rules = ruleEntries.map((rule) => text(record(rule, "SARIF driver rule").id, "SARIF driver rule ID", 200));
    if (new Set(rules).size !== rules.length) throw new Error("SARIF driver rule ID가 중복됐습니다");
    const results = run.results === undefined ? [] : array(run.results, "SARIF results");
    resultCount += results.length;
    if (resultCount > options.maximumResults) throw new Error("SARIF result 상한을 초과했습니다");
    for (const resultValue of results) {
      const result = record(resultValue, "SARIF result");
      const sourceRule = ruleId(result, rules);
      const level = result.level === undefined ? "warning" : text(result.level, "SARIF result level", 20);
      const severity = LEVELS[level];
      if (!severity) throw new Error("SARIF result level이 올바르지 않습니다");
      const message = text(record(result.message, "SARIF result message").text, "SARIF result message", 4_000);
      for (const location of locations(result.locations)) {
        if (findings.length >= options.maximumResults) throw new Error("SARIF finding 상한을 초과했습니다");
        findings.push({
          category: options.category,
          severity,
          message,
          ...(location ? { location } : {}),
          evidenceReferenceIds: [options.artifactVersionId],
          sourceTool,
          sourceRule,
          controlReferences: [],
        });
      }
    }
  }
  const outputHash = sha256(
    canonicalJson({
      artifactVersionId: options.artifactVersionId,
      artifactChecksum,
      findings,
      runCount: runs.length,
      resultCount,
    }),
  );
  return {
    artifactVersionId: options.artifactVersionId,
    artifactChecksum,
    outputHash,
    runCount: runs.length,
    resultCount,
    findings,
  };
}

interface SarifArtifactRecord {
  readonly artifact_version_id: string;
  readonly checksum: string;
  readonly content_json: string;
}

/** DB ArtifactVersion의 SARIF를 CheckStore의 원자 Check/Finding 저장 경로에 연결합니다. */
export class SarifAssuranceInspectionExecutor implements TrustedAssuranceInspectionExecutor {
  public readonly inspectorProfile: string;

  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly config: {
      readonly inspectorProfile: string;
      readonly category: SarifFindingCategory;
      readonly maximumBytes: number;
      readonly maximumRuns: number;
      readonly maximumResults: number;
      readonly toolVersion: string;
    },
  ) {
    this.inspectorProfile = config.inspectorProfile;
  }

  public async execute(
    context: TenantContext,
    input: TrustedAssuranceInspectionExecutionInput,
  ): Promise<TrustedAssuranceInspectionExecutionResult> {
    await this.organizations.verifyTenantContext(context);
    const blocked = (category: string): TrustedAssuranceInspectionExecutionResult => ({
      status: "blocked",
      outputHash: sha256(
        canonicalJson({ category, assuranceRunId: input.assuranceRunId, criterionId: input.criterionId }),
      ),
      summary: "SARIF ArtifactVersion을 판정할 수 없습니다",
      evidenceReferenceIds: input.artifactVersionIds,
      artifactVersionIds: input.artifactVersionIds,
      evidenceBriefIds: [],
      metricObservationIds: [],
      humanAttestationIds: [],
      toolName: this.inspectorProfile,
      toolVersion: this.config.toolVersion,
      durationMs: 0,
      findings: [],
    });
    if (
      input.binding.inspectorProfile !== this.inspectorProfile ||
      input.artifactVersionIds.length === 0 ||
      input.evidenceBriefIds.length > 0 ||
      !input.binding.evidenceAllowlist.includes("artifact-version")
    ) {
      return blocked("sarif_binding_invalid");
    }
    const [records] = await this.database.query<[SarifArtifactRecord[]]>(
      "SELECT artifact_version_id, checksum, content_json FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id IN $ids;",
      { organization_id: context.organizationId, work_id: input.workId, ids: input.artifactVersionIds },
    );
    if (records.length !== input.artifactVersionIds.length) return blocked("sarif_artifact_missing");
    const startedAt = Date.now();
    try {
      const ingested = records
        .sort((left, right) => left.artifact_version_id.localeCompare(right.artifact_version_id))
        .map((record) =>
          ingestSarif(new TextEncoder().encode(record.content_json), {
            artifactVersionId: record.artifact_version_id,
            expectedChecksum: record.checksum,
            category: this.config.category,
            maximumBytes: this.config.maximumBytes,
            maximumRuns: this.config.maximumRuns,
            maximumResults: Math.min(this.config.maximumResults, input.binding.maximumFindings),
          }),
        );
      const findings = ingested.flatMap((item) => item.findings);
      if (findings.length > input.binding.maximumFindings) return blocked("sarif_finding_limit");
      return {
        status: "passed",
        outputHash: sha256(canonicalJson(ingested.map((item) => item.outputHash))),
        summary: `SARIF finding ${String(findings.length)}건`,
        evidenceReferenceIds: input.artifactVersionIds,
        artifactVersionIds: input.artifactVersionIds,
        evidenceBriefIds: [],
        metricObservationIds: [],
        humanAttestationIds: [],
        toolName: this.inspectorProfile,
        toolVersion: this.config.toolVersion,
        durationMs: Math.max(0, Date.now() - startedAt),
        findings,
      };
    } catch {
      return blocked("sarif_invalid");
    }
  }
}
