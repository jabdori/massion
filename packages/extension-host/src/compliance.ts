import { createHash } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { inspectExtensionArchive } from "./artifact-inspector.js";
import type { ExtensionRuntimeVersions } from "./contracts.js";
import { EXTENSION_MIGRATIONS } from "./schema.js";
import type { FileArtifactStore } from "./store.js";

interface VersionAuditRecord {
  readonly version_id: string;
  readonly installation_id: string;
  readonly artifact_digest: string;
  readonly content_digest: string;
  readonly manifest_json: string;
  readonly manifest_digest: string;
  readonly permission_json: string;
  readonly permission_digest: string;
  readonly trust_level: "built-in" | "verified" | "community" | "untrusted-local";
}

interface InstallationAuditRecord {
  readonly installation_id: string;
  readonly state: string;
  readonly active_version_id?: string;
  readonly activation_generation: number;
}

interface ActivationAuditRecord {
  readonly after_version_id: string;
  readonly after_generation: number;
  readonly governance_decision_ids: readonly string[];
  readonly health_receipt_json: string;
  readonly sandbox_receipt_json?: string;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface ExtensionComplianceReport {
  readonly compliant: boolean;
  readonly violations: readonly string[];
}

export class ExtensionComplianceAuditor {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly artifacts: FileArtifactStore,
    private readonly runtime: ExtensionRuntimeVersions,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    artifacts: FileArtifactStore,
    runtime: ExtensionRuntimeVersions = { agentOS: "1.0.0", node: process.versions.node, surrealDB: "3.2.0" },
  ): Promise<ExtensionComplianceAuditor> {
    await applyMigrations(database, EXTENSION_MIGRATIONS);
    return new ExtensionComplianceAuditor(database, organizations, artifacts, runtime);
  }

  public async audit(context: TenantContext): Promise<ExtensionComplianceReport> {
    await this.organizations.verifyTenantContext(context);
    const violations: string[] = [];
    const [versions] = await this.database.query<[VersionAuditRecord[]]>(
      "SELECT * OMIT id FROM extension_version WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const versionMap = new Map(versions.map((version) => [version.version_id, version]));
    for (const version of versions) {
      try {
        const manifest = JSON.parse(version.manifest_json) as unknown;
        const permissions = JSON.parse(version.permission_json) as unknown;
        if (sha256(canonicalJson(manifest)) !== version.manifest_digest) violations.push("manifest-digest");
        if (sha256(canonicalJson(permissions)) !== version.permission_digest) violations.push("permission-digest");
      } catch {
        violations.push("manifest-json");
      }
      try {
        const archive = await this.artifacts.read(context.organizationId, version.artifact_digest);
        const report = await inspectExtensionArchive(archive, { runtime: this.runtime });
        if (report.artifactDigest !== version.artifact_digest) violations.push("artifact-digest");
        if (report.contentDigest !== version.content_digest) violations.push("artifact-content-digest");
      } catch {
        violations.push("artifact-corrupt-or-missing");
      }
    }
    const [installations] = await this.database.query<[InstallationAuditRecord[]]>(
      "SELECT * OMIT id FROM extension_installation WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    for (const installation of installations) {
      if (installation.state !== "active") continue;
      if (!installation.active_version_id) {
        violations.push("active-version-missing");
        continue;
      }
      const version = versionMap.get(installation.active_version_id);
      if (!version || version.installation_id !== installation.installation_id) {
        violations.push("active-version-lineage");
        continue;
      }
      const [activations] = await this.database.query<[ActivationAuditRecord[]]>(
        "SELECT * OMIT id FROM extension_activation WHERE organization_id = $organization_id AND installation_id = $installation_id ORDER BY after_generation DESC LIMIT 1;",
        { organization_id: context.organizationId, installation_id: installation.installation_id },
      );
      const activation = activations[0];
      if (
        !activation ||
        activation.after_version_id !== installation.active_version_id ||
        activation.after_generation !== installation.activation_generation
      ) {
        violations.push("activation-generation-lineage");
        continue;
      }
      if (activation.governance_decision_ids.length === 0) violations.push("governance-decision-missing");
      try {
        const health = JSON.parse(activation.health_receipt_json) as { status?: string };
        if (health.status !== "healthy") violations.push("health-receipt-invalid");
      } catch {
        violations.push("health-receipt-invalid");
      }
      if (version.trust_level !== "built-in" && !activation.sandbox_receipt_json) {
        violations.push("sandbox-receipt-missing");
      }
      const [grants] = await this.database.query<[Array<{ permission_digest: string }>]>(
        "SELECT permission_digest FROM extension_capability_grant WHERE organization_id = $organization_id AND version_id = $version_id LIMIT 1;",
        { organization_id: context.organizationId, version_id: version.version_id },
      );
      if (grants[0]?.permission_digest !== version.permission_digest) violations.push("capability-grant-lineage");
    }
    const [storage] = await this.database.query<[Array<{ value_json: string; checksum: string }>]>(
      "SELECT value_json, checksum FROM extension_storage WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    if (storage.some((record) => sha256(record.value_json) !== record.checksum)) violations.push("storage-checksum");
    const unique = [...new Set(violations)].sort();
    return { compliant: unique.length === 0, violations: unique };
  }

  public async assertCompliant(context: TenantContext): Promise<void> {
    const report = await this.audit(context);
    if (!report.compliant) throw new Error(`Extension compliance 위반: ${report.violations.join(",")}`);
  }
}
