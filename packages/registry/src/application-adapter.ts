import type { ExtensionRuntimeVersions } from "@massion/extension-host";
import type { TenantContext } from "@massion/identity";

import type { RegistryCatalog, RegistryCatalogStore } from "./catalog.js";
import type { RegistryRecall, RegistryVersion } from "./contracts.js";

export class RegistryApplicationAdapter {
  public constructor(
    private readonly dependencies: {
      readonly catalog: RegistryCatalog;
      readonly versions: {
        get(context: TenantContext, versionId: string): Promise<RegistryVersion>;
        recall(context: TenantContext, versionId: string, recall: RegistryRecall): Promise<RegistryVersion>;
        supersedeRecall?(
          context: TenantContext,
          versionId: string,
          input: { recallId: string; supersedesRecallId: string; reason: string },
        ): Promise<RegistryVersion>;
      };
      readonly catalogVersions: RegistryCatalogStore;
      readonly installer: {
        install(
          context: TenantContext,
          input: {
            commandId: string;
            downloadGrant: string;
            environment: string;
            riskClass: string;
            executionId: string;
            installApprovalId?: string;
            permissionApprovalId?: string;
          },
        ): Promise<unknown>;
      };
      readonly inventory: {
        list(context: TenantContext): Promise<
          readonly {
            installationId: string;
            packageName: string;
            packageVersion?: string;
            state?: string;
          }[]
        >;
      };
      readonly runtime: ExtensionRuntimeVersions;
    },
  ) {}

  public async search(
    context: TenantContext,
    input: { readonly query: string; readonly limit: number; readonly cursor?: string },
  ): Promise<unknown> {
    return await this.dependencies.catalog.search({
      organizationId: context.organizationId,
      query: input.query,
      runtime: this.dependencies.runtime,
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  }

  public async info(context: TenantContext, versionId: string): Promise<unknown> {
    return await this.dependencies.catalog.info(context.organizationId, versionId);
  }

  public async install(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly versionId: string;
      readonly environment: string;
      readonly riskClass: string;
      readonly executionId: string;
      readonly installApprovalId?: string;
      readonly permissionApprovalId?: string;
    },
  ): Promise<{ readonly installationId: string; readonly packageName: string; readonly packageVersion: string }> {
    const grant = await this.dependencies.catalog.issueDownload({
      organizationId: context.organizationId,
      versionId: input.versionId,
    });
    return (await this.dependencies.installer.install(context, {
      commandId: input.commandId,
      downloadGrant: grant.token,
      environment: input.environment,
      riskClass: input.riskClass,
      executionId: input.executionId,
      ...(input.installApprovalId === undefined ? {} : { installApprovalId: input.installApprovalId }),
      ...(input.permissionApprovalId === undefined ? {} : { permissionApprovalId: input.permissionApprovalId }),
    })) as { installationId: string; packageName: string; packageVersion: string };
  }

  public async recall(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly versionId: string;
      readonly category: RegistryRecall["category"];
      readonly severity: RegistryRecall["severity"];
      readonly reason: string;
      readonly supersedesRecallId?: string;
    },
  ): Promise<{ readonly recallId: string; readonly versionId: string }> {
    if (input.supersedesRecallId !== undefined) {
      if (!this.dependencies.versions.supersedeRecall)
        throw new Error("Registry recall supersede adapter가 구성되지 않았습니다");
      await this.dependencies.versions.supersedeRecall(context, input.versionId, {
        recallId: input.commandId,
        supersedesRecallId: input.supersedesRecallId,
        reason: input.reason,
      });
    } else {
      await this.dependencies.versions.recall(context, input.versionId, {
        recallId: input.commandId,
        category: input.category,
        severity: input.severity,
        reason: input.reason,
      });
    }
    return { recallId: input.commandId, versionId: input.versionId };
  }

  public async inventory(context: TenantContext): Promise<readonly unknown[]> {
    const [installed, versions] = await Promise.all([
      this.dependencies.inventory.list(context),
      this.dependencies.catalogVersions.list(),
    ]);
    const findings: unknown[] = [];
    for (const installation of installed) {
      const recalled = versions.find(
        (version) =>
          version.state === "recalled" &&
          version.packageName === installation.packageName &&
          (installation.packageVersion === undefined || version.packageVersion === installation.packageVersion),
      );
      if (!recalled) continue;
      const recalls = await this.dependencies.catalogVersions.listRecalls(recalled.versionId);
      findings.push({
        installationId: installation.installationId,
        packageName: installation.packageName,
        packageVersion: recalled.packageVersion,
        state: installation.state ?? "unknown",
        severity: recalls.at(-1)?.severity ?? "high",
        reason: recalls.at(-1)?.reason ?? "Registry recall",
      });
    }
    return findings;
  }
}
