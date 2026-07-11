import type { ExtensionRuntimeVersions } from "@massion/extension-host";
import type { TenantContext } from "@massion/identity";

import type { ArtifactStore } from "./artifact-store.js";
import {
  assessmentPassed,
  type PublicationPolicy,
  type RegistryAssessment,
  type RegistryVersion,
  type RegistryVisibility,
} from "./contracts.js";
import type { RegistryInspectionPipeline } from "./pipeline.js";
import type { ProvenancePolicy } from "./provenance.js";
import { decidePublication } from "./publication-policy.js";

function metadata(value: unknown): {
  uploadGrant: string;
  provenanceBundle: unknown;
  visibility: RegistryVisibility;
  publicationPolicy: PublicationPolicy;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Registry publish metadata는 object여야 합니다");
  const source = value as Record<string, unknown>;
  const allowed = ["uploadGrant", "provenanceBundle", "visibility", "publicationPolicy"];
  const unknown = Object.keys(source).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Registry publish metadata에 알 수 없는 필드가 있습니다: ${unknown}`);
  if (typeof source.uploadGrant !== "string" || source.uploadGrant.length < 3 || source.uploadGrant.length > 1024)
    throw new Error("uploadGrant가 유효하지 않습니다");
  if (source.provenanceBundle === undefined) throw new Error("provenanceBundle이 필요합니다");
  if (source.visibility !== "public" && source.visibility !== "private")
    throw new Error("Registry visibility가 유효하지 않습니다");
  if (!(["manual", "risk-based", "automatic"] as const).includes(source.publicationPolicy as never))
    throw new Error("Registry publicationPolicy가 유효하지 않습니다");
  return {
    uploadGrant: source.uploadGrant,
    provenanceBundle: source.provenanceBundle,
    visibility: source.visibility,
    publicationPolicy: source.publicationPolicy as PublicationPolicy,
  };
}

export class RegistryApplicationPublisher {
  public constructor(
    private readonly dependencies: {
      readonly pipeline: Pick<RegistryInspectionPipeline, "inspect">;
      readonly grants: {
        consume(
          token: string,
          expected: { packageName: string; packageVersion: string; artifactDigest: string },
        ): unknown;
      };
      readonly artifacts: ArtifactStore;
      readonly versions: {
        stage(
          context: TenantContext,
          commandId: string,
          input: {
            packageName: string;
            packageVersion: string;
            artifactDigest: string;
            contentDigest: string;
            visibility: RegistryVisibility;
            ownerOrganizationId: string;
            manifest: Readonly<Record<string, unknown>>;
          },
        ): Promise<RegistryVersion>;
        recordAssessment(
          context: TenantContext,
          versionId: string,
          assessment: RegistryAssessment,
        ): Promise<RegistryVersion>;
        publish(context: TenantContext, versionId: string, decisionId: string): Promise<RegistryVersion>;
      };
      readonly runtime: ExtensionRuntimeVersions;
      readonly provenancePolicy: ProvenancePolicy;
    },
  ) {}

  public async publish(
    context: TenantContext,
    input: { readonly commandId: string; readonly archive: Buffer; readonly metadata: unknown },
  ): Promise<RegistryVersion> {
    const options = metadata(input.metadata);
    const inspected = await this.dependencies.pipeline.inspect({
      archive: input.archive,
      provenanceBundle: options.provenanceBundle,
      provenancePolicy: this.dependencies.provenancePolicy,
      runtime: this.dependencies.runtime,
    });
    const manifest = inspected.artifact.manifest;
    this.dependencies.grants.consume(options.uploadGrant, {
      packageName: manifest.name,
      packageVersion: manifest.version,
      artifactDigest: inspected.artifact.artifactDigest,
    });
    await this.dependencies.artifacts.put(inspected.artifact.artifactDigest, input.archive);
    const staged = await this.dependencies.versions.stage(context, input.commandId, {
      packageName: manifest.name,
      packageVersion: manifest.version,
      artifactDigest: inspected.artifact.artifactDigest,
      contentDigest: inspected.artifact.contentDigest,
      visibility: options.visibility,
      ownerOrganizationId: context.organizationId,
      manifest: manifest as unknown as Readonly<Record<string, unknown>>,
    });
    const assessed = await this.dependencies.versions.recordAssessment(context, staged.versionId, inspected.assessment);
    const decision = decidePublication({
      policy: options.publicationPolicy,
      assessmentPassed: assessmentPassed(assessed.assessment),
      risk: "low",
      trustChanged: false,
      permissionsIncreased: false,
    });
    if (decision !== "publish") return assessed;
    return await this.dependencies.versions.publish(context, assessed.versionId, `${input.commandId}:automatic`);
  }
}
