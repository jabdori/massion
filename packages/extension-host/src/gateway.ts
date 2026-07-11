import type { TenantContext } from "@massion/identity";

import type { ExtensionChangeInput, InvokeExtensionInput, RollbackExtensionInput } from "./lifecycle.js";

interface LifecycleGatewayPort {
  install(context: TenantContext, input: ExtensionChangeInput): Promise<unknown>;
  update(context: TenantContext, input: ExtensionChangeInput): Promise<unknown>;
  rollback(context: TenantContext, input: RollbackExtensionInput): Promise<unknown>;
  list(context: TenantContext): Promise<readonly unknown[]>;
  invoke(context: TenantContext, input: InvokeExtensionInput): Promise<unknown>;
}

interface PackageGatewayPort {
  validate(source: string): Promise<{
    readonly sourceDigest: string;
    readonly sourcePath: string;
    readonly manifest: { readonly name: string; readonly version: string };
    readonly files: readonly string[];
  }>;
  link(
    source: string,
    options: { readonly environment: string },
  ): Promise<{
    readonly sourcePath: string;
    readonly sourceDigest: string;
    readonly trustLevel: string;
    readonly validatedAt: string;
  }>;
  pack(
    source: string,
    destination: string,
  ): Promise<{
    readonly tarballPath: string;
    readonly artifact: {
      readonly artifactDigest: string;
      readonly manifest: { readonly name: string; readonly version: string };
    };
  }>;
}

export class ExtensionGateway {
  public constructor(
    private readonly lifecycle: LifecycleGatewayPort,
    private readonly packages: PackageGatewayPort,
  ) {}

  public async validate(source: string) {
    const report = await this.packages.validate(source);
    return {
      sourceDigest: report.sourceDigest,
      packageName: report.manifest.name,
      packageVersion: report.manifest.version,
      files: report.files,
    };
  }

  public async link(source: string, options: { readonly environment: string }) {
    const linked = await this.packages.link(source, options);
    return {
      sourceDigest: linked.sourceDigest,
      trustLevel: linked.trustLevel,
      validatedAt: linked.validatedAt,
    };
  }

  public async pack(source: string, destination: string) {
    const packed = await this.packages.pack(source, destination);
    return {
      artifactDigest: packed.artifact.artifactDigest,
      packageName: packed.artifact.manifest.name,
      packageVersion: packed.artifact.manifest.version,
    };
  }

  public async install(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly archive: Buffer;
      readonly environment?: string;
      readonly riskClass?: string;
      readonly executionId?: string;
      readonly installApprovalId?: string;
      readonly permissionApprovalId?: string;
    },
  ) {
    return await this.lifecycle.install(context, {
      commandId: input.commandId,
      archive: input.archive,
      environment: input.environment ?? "local",
      riskClass: input.riskClass ?? "extension-install",
      executionId: input.executionId ?? `surface:${input.commandId}`,
      ...(input.installApprovalId === undefined ? {} : { installApprovalId: input.installApprovalId }),
      ...(input.permissionApprovalId === undefined ? {} : { permissionApprovalId: input.permissionApprovalId }),
    });
  }

  public async update(context: TenantContext, input: Parameters<ExtensionGateway["install"]>[1]) {
    return await this.lifecycle.update(context, {
      commandId: input.commandId,
      archive: input.archive,
      environment: input.environment ?? "local",
      riskClass: input.riskClass ?? "extension-update",
      executionId: input.executionId ?? `surface:${input.commandId}`,
      ...(input.installApprovalId === undefined ? {} : { installApprovalId: input.installApprovalId }),
      ...(input.permissionApprovalId === undefined ? {} : { permissionApprovalId: input.permissionApprovalId }),
    });
  }

  public async rollback(context: TenantContext, input: RollbackExtensionInput) {
    return await this.lifecycle.rollback(context, input);
  }

  public async list(context: TenantContext) {
    return await this.lifecycle.list(context);
  }

  public async invoke(context: TenantContext, input: InvokeExtensionInput) {
    return await this.lifecycle.invoke(context, input);
  }
}
