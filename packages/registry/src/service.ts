import { createHash } from "node:crypto";

import type { ExtensionRuntimeVersions } from "@massion/extension-host";

import type { ArtifactStore } from "./artifact-store.js";
import {
  assessmentPassed,
  type PublicationPolicy,
  type RegistryAssessment,
  type RegistryVersion,
  type RegistryVisibility,
} from "./contracts.js";
import type { ProvenancePolicy } from "./provenance.js";
import { decidePublication } from "./publication-policy.js";
import type { RegistryInspectionPipeline } from "./pipeline.js";

export interface RegistryMutableStore {
  stage(
    commandId: string,
    input: {
      readonly packageName: string;
      readonly packageVersion: string;
      readonly artifactDigest: string;
      readonly contentDigest: string;
      readonly visibility: RegistryVisibility;
      readonly ownerOrganizationId: string;
      readonly manifest: Readonly<Record<string, unknown>>;
    },
  ): Promise<RegistryVersion>;
  recordAssessment(versionId: string, assessment: RegistryAssessment): Promise<RegistryVersion>;
  publish(versionId: string, decisionId: string): Promise<RegistryVersion>;
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly values = new Map<string, Buffer>();
  public async put(digest: string, body: Buffer): Promise<void> {
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== digest) throw new Error("artifact body가 digest와 일치하지 않습니다");
    const existing = this.values.get(digest);
    if (existing && !existing.equals(body)) throw new Error("같은 digest에 다른 artifact를 저장할 수 없습니다");
    this.values.set(digest, Buffer.from(body));
  }
  public async get(digest: string): Promise<Buffer> {
    const body = this.values.get(digest);
    if (!body) throw new Error("Registry artifact를 찾을 수 없습니다");
    return Buffer.from(body);
  }
}

export class RegistryService {
  public constructor(
    private readonly dependencies: {
      readonly store: RegistryMutableStore;
      readonly artifacts: ArtifactStore;
      readonly pipeline: Pick<RegistryInspectionPipeline, "inspect">;
      readonly grants: {
        consume(
          token: string,
          expected: { packageName: string; packageVersion: string; artifactDigest: string },
        ): unknown;
      };
    },
  ) {}

  public async stage(input: {
    readonly commandId: string;
    readonly organizationId: string;
    readonly uploadGrant: string;
    readonly archive: Buffer;
    readonly provenanceBundle: unknown;
    readonly provenancePolicy: ProvenancePolicy;
    readonly runtime: ExtensionRuntimeVersions;
    readonly visibility: RegistryVisibility;
    readonly publicationPolicy: PublicationPolicy;
  }): Promise<RegistryVersion> {
    const inspected = await this.dependencies.pipeline.inspect({
      archive: input.archive,
      provenanceBundle: input.provenanceBundle,
      provenancePolicy: input.provenancePolicy,
      runtime: input.runtime,
    });
    const identity = inspected.artifact.manifest;
    this.dependencies.grants.consume(input.uploadGrant, {
      packageName: identity.name,
      packageVersion: identity.version,
      artifactDigest: inspected.artifact.artifactDigest,
    });
    await this.dependencies.artifacts.put(inspected.artifact.artifactDigest, input.archive);
    const staged = await this.dependencies.store.stage(input.commandId, {
      packageName: identity.name,
      packageVersion: identity.version,
      artifactDigest: inspected.artifact.artifactDigest,
      contentDigest: inspected.artifact.contentDigest,
      visibility: input.visibility,
      ownerOrganizationId: input.organizationId,
      manifest: identity as unknown as Readonly<Record<string, unknown>>,
    });
    const assessed = await this.dependencies.store.recordAssessment(staged.versionId, inspected.assessment);
    const decision = decidePublication({
      policy: input.publicationPolicy,
      assessmentPassed: assessmentPassed(assessed.assessment),
      risk: "low",
      trustChanged: false,
      permissionsIncreased: false,
    });
    if (decision !== "publish") return assessed;
    return await this.dependencies.store.publish(assessed.versionId, `${input.commandId}:automatic`);
  }

  public async artifact(digest: string): Promise<Buffer> {
    return await this.dependencies.artifacts.get(digest);
  }
}
