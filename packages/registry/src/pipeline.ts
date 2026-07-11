import { inspectExtensionArchive, type ExtensionArtifactReport, type ExtensionRuntimeVersions } from "@massion/extension-host";

import type { AssessmentOutcome, RegistryAssessment } from "./contracts.js";
import type { ProvenancePolicy, ProvenanceResult } from "./provenance.js";

export interface SbomComponent {
  readonly ecosystem: "npm";
  readonly name: string;
  readonly version: string;
}

export interface RegistrySbom {
  readonly format: "CycloneDX";
  readonly specVersion: "1.6";
  readonly components: readonly SbomComponent[];
}

export interface VulnerabilityFinding {
  readonly id: string;
  readonly severity: "low" | "medium" | "high" | "critical";
}

export interface VulnerabilityClient {
  query(components: readonly SbomComponent[]): Promise<readonly VulnerabilityFinding[]>;
}

export interface ContractProbe {
  probe(artifact: ExtensionArtifactReport): Promise<{ readonly outcome: AssessmentOutcome; readonly detail?: string }>;
}

export interface RegistryPolicyAssessor {
  assess(artifact: ExtensionArtifactReport): Promise<{
    readonly outcome: AssessmentOutcome;
    readonly risk: "low" | "medium" | "high" | "critical";
  }>;
}

export interface RegistryProvenanceVerifier {
  verify(artifact: Buffer, bundle: unknown, policy: ProvenancePolicy): Promise<ProvenanceResult>;
}

function dependencies(packageJson: Readonly<Record<string, unknown>>): RegistrySbom {
  const result: SbomComponent[] = [];
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const value = packageJson[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
      if (typeof version !== "string" || name.length > 214 || version.length > 128) throw new Error("dependency가 유효하지 않습니다");
      result.push({ ecosystem: "npm", name, version });
    }
  }
  result.sort((left, right) => left.name.localeCompare(right.name));
  if (result.length > 2_000) throw new Error("SBOM component 상한을 초과했습니다");
  return { format: "CycloneDX", specVersion: "1.6", components: result };
}

export class RegistryInspectionPipeline {
  private readonly inspectArchive: (
    archive: Buffer,
    options: { readonly runtime: ExtensionRuntimeVersions },
  ) => Promise<ExtensionArtifactReport>;

  public constructor(
    private readonly options: {
      readonly inspectArchive?: (
        archive: Buffer,
        options: { readonly runtime: ExtensionRuntimeVersions },
      ) => Promise<ExtensionArtifactReport>;
      readonly provenance: RegistryProvenanceVerifier;
      readonly vulnerabilities: VulnerabilityClient;
      readonly contractProbe: ContractProbe;
      readonly policy: RegistryPolicyAssessor;
    },
  ) {
    this.inspectArchive = options.inspectArchive ?? inspectExtensionArchive;
  }

  public async inspect(input: {
    readonly archive: Buffer;
    readonly provenanceBundle: unknown;
    readonly provenancePolicy: ProvenancePolicy;
    readonly runtime: ExtensionRuntimeVersions;
  }): Promise<{
    readonly artifact: ExtensionArtifactReport;
    readonly provenance?: ProvenanceResult;
    readonly sbom: RegistrySbom;
    readonly vulnerabilities: readonly VulnerabilityFinding[];
    readonly assessment: RegistryAssessment;
  }> {
    const artifact = await this.inspectArchive(input.archive, { runtime: input.runtime });
    const sbom = dependencies(artifact.packageJson);
    let provenance: ProvenanceResult | undefined;
    let provenanceOutcome: AssessmentOutcome = "unknown";
    try {
      provenance = await this.options.provenance.verify(input.archive, input.provenanceBundle, input.provenancePolicy);
      provenanceOutcome = provenance.outcome;
    } catch {
      provenanceOutcome = "fail";
    }
    let findings: readonly VulnerabilityFinding[] = [];
    let vulnerability: AssessmentOutcome = "unknown";
    try {
      findings = await this.options.vulnerabilities.query(sbom.components);
      vulnerability = findings.some((finding) => finding.severity === "high" || finding.severity === "critical")
        ? "fail"
        : "pass";
    } catch {
      vulnerability = "unknown";
    }
    const contract = await this.options.contractProbe.probe(artifact).catch(() => ({ outcome: "unknown" as const }));
    const policy = await this.options.policy.assess(artifact).catch(() => ({ outcome: "unknown" as const, risk: "critical" as const }));
    return {
      artifact,
      ...(provenance ? { provenance } : {}),
      sbom,
      vulnerabilities: findings,
      assessment: {
        archive: "pass",
        provenance: provenanceOutcome,
        sbom: "pass",
        vulnerability,
        contract: contract.outcome,
        policy: policy.outcome,
      },
    };
  }
}

export class OsvClient implements VulnerabilityClient {
  public constructor(private readonly fetcher: typeof fetch = fetch) {}

  public async query(components: readonly SbomComponent[]): Promise<readonly VulnerabilityFinding[]> {
    if (components.length === 0) return [];
    const response = await this.fetcher("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: components.map((component) => ({ package: { ecosystem: "npm", name: component.name }, version: component.version })) }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`OSV query가 실패했습니다: ${String(response.status)}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error("OSV response byte 상한을 초과했습니다");
    const value = JSON.parse(body) as { results?: { vulns?: { id?: unknown }[] }[] };
    const ids = new Set<string>();
    for (const result of value.results ?? []) {
      for (const vulnerability of result.vulns ?? []) {
        if (typeof vulnerability.id === "string" && vulnerability.id.length <= 128) ids.add(vulnerability.id);
      }
    }
    return [...ids].sort().map((id) => ({ id, severity: "high" as const }));
  }
}
