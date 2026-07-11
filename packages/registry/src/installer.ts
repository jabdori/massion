import { createHash } from "node:crypto";

import {
  inspectExtensionArchive,
  type ExtensionArtifactReport,
  type ExtensionRuntimeVersions,
} from "@massion/extension-host";
import type { TenantContext } from "@massion/identity";

import type { ArtifactStore } from "./artifact-store.js";
import type { RegistryCatalog } from "./catalog.js";

export interface RegistryLifecycle {
  installRegistry(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly archive: Buffer;
      readonly environment: string;
      readonly riskClass: string;
      readonly executionId: string;
      readonly trustLevel: "verified" | "community";
      readonly installApprovalId?: string;
      readonly permissionApprovalId?: string;
    },
  ): Promise<unknown>;
}

export class RegistryInstaller {
  private readonly inspectArchive: (
    archive: Buffer,
    options: { readonly runtime: ExtensionRuntimeVersions },
  ) => Promise<ExtensionArtifactReport>;

  public constructor(
    private readonly dependencies: {
      readonly catalog: Pick<RegistryCatalog, "verifyDownload">;
      readonly artifacts: ArtifactStore;
      readonly lifecycle: RegistryLifecycle;
      readonly runtime: ExtensionRuntimeVersions;
      readonly inspectArchive?: (
        archive: Buffer,
        options: { readonly runtime: ExtensionRuntimeVersions },
      ) => Promise<ExtensionArtifactReport>;
    },
  ) {
    this.inspectArchive = dependencies.inspectArchive ?? inspectExtensionArchive;
  }

  public async install(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly downloadGrant: string;
      readonly environment: string;
      readonly riskClass: string;
      readonly executionId: string;
      readonly installApprovalId?: string;
      readonly permissionApprovalId?: string;
    },
  ): Promise<unknown> {
    const version = await this.dependencies.catalog.verifyDownload(input.downloadGrant, context.organizationId);
    const archive = await this.dependencies.artifacts.get(version.artifactDigest);
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== version.artifactDigest) throw new Error("downloaded Registry artifact digest가 catalog와 다릅니다");
    const report = await this.inspectArchive(archive, { runtime: this.dependencies.runtime });
    if (
      report.artifactDigest !== version.artifactDigest ||
      report.manifest.name !== version.packageName ||
      report.manifest.version !== version.packageVersion
    )
      throw new Error("downloaded Registry artifact identity가 catalog와 다릅니다");
    return await this.dependencies.lifecycle.installRegistry(context, {
      commandId: input.commandId,
      archive,
      environment: input.environment,
      riskClass: input.riskClass,
      executionId: input.executionId,
      trustLevel: "verified",
      ...(input.installApprovalId === undefined ? {} : { installApprovalId: input.installApprovalId }),
      ...(input.permissionApprovalId === undefined ? {} : { permissionApprovalId: input.permissionApprovalId }),
    });
  }
}
