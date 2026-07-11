import type { ExtensionContributionDeclaration, ExtensionTrustLevel } from "@massion/extension-sdk";
import type { TenantContext } from "@massion/identity";

import { inspectExtensionArchive } from "./artifact-inspector.js";
import type { ExtensionRuntimeVersions } from "./contracts.js";
import type { AuthorizeExtensionChangeInput, ExtensionPermissionDiff } from "./governance-adapter.js";
import {
  ExtensionStore,
  FileArtifactStore,
  type ExtensionInstallationView,
  type ExtensionVersionDetails,
} from "./store.js";
import type {
  ExtensionWorkerHandle,
  ExtensionWorkerSupervisor,
  StartExtensionWorkerInput,
} from "./worker-supervisor.js";

export interface ExtensionLifecycleAuthorizer {
  authorize(
    context: TenantContext,
    input: AuthorizeExtensionChangeInput,
  ): Promise<{ readonly decisionIds: readonly string[]; readonly permissionDiff: ExtensionPermissionDiff }>;
}

export interface ExtensionWorkerLauncher {
  start(input: StartExtensionWorkerInput): Promise<ExtensionWorkerHandle>;
}

export interface ExtensionChangeInput {
  readonly commandId: string;
  readonly archive: Buffer;
  readonly environment: string;
  readonly riskClass: string;
  readonly executionId: string;
  readonly installApprovalId?: string;
  readonly permissionApprovalId?: string;
}

export interface ExtensionActivationView {
  readonly installationId: string;
  readonly versionId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactDigest: string;
  readonly permissionDigest: string;
  readonly activationGeneration: number;
  readonly state: "active";
}

export interface RollbackExtensionInput {
  readonly commandId: string;
  readonly packageName: string;
  readonly targetVersionId: string;
  readonly environment: string;
  readonly riskClass: string;
  readonly executionId: string;
  readonly installApprovalId?: string;
  readonly permissionApprovalId?: string;
}

export interface InvokeExtensionInput {
  readonly packageName: string;
  readonly contribution: string;
  readonly payload: unknown;
  readonly timeoutMs: number;
}

interface ActiveWorker {
  readonly organizationId: string;
  readonly installationId: string;
  readonly versionId: string;
  readonly activationGeneration: number;
  readonly contributions: readonly string[];
  readonly handle: ExtensionWorkerHandle;
}

function contributionIds(contributions: ExtensionContributionDeclaration): readonly string[] {
  const values: string[] = [];
  const groups: readonly [string, readonly { readonly id: string }[]][] = [
    ["runtimeTools", contributions.runtimeTools],
    ["organizationTemplates", contributions.organizationTemplates],
    ["growthSignals", contributions.growthSignals],
    ["growthTargets", contributions.growthTargets],
    ["surfaceConnectors", contributions.surfaceConnectors],
    ["eventConsumers", contributions.eventConsumers],
    ["skills", contributions.skills],
  ];
  for (const [kind, entries] of groups) {
    for (const entry of entries) values.push(`${kind}:${entry.id}`);
  }
  return values.sort();
}

function activeKey(organizationId: string, installationId: string): string {
  return `${organizationId}:${installationId}`;
}

export class ExtensionLifecycleService {
  private readonly activeWorkers = new Map<string, ActiveWorker>();
  private readonly contributionOwners = new Map<string, string>();

  public constructor(
    private readonly dependencies: {
      readonly runtime: ExtensionRuntimeVersions;
      readonly store: ExtensionStore;
      readonly artifacts: FileArtifactStore;
      readonly authorizer: ExtensionLifecycleAuthorizer;
      readonly workers: ExtensionWorkerLauncher | ExtensionWorkerSupervisor;
    },
  ) {}

  public async install(context: TenantContext, input: ExtensionChangeInput): Promise<ExtensionActivationView> {
    return await this.activateArchive(context, input, "untrusted-local", "tarball");
  }

  public async update(context: TenantContext, input: ExtensionChangeInput): Promise<ExtensionActivationView> {
    return await this.activateArchive(context, input, "untrusted-local", "tarball");
  }

  public async rollback(context: TenantContext, input: RollbackExtensionInput): Promise<ExtensionActivationView> {
    const installation = await this.dependencies.store.findInstallation(context, input.packageName);
    if (!installation?.activeVersionId) throw new Error("rollback할 active Extension installation이 없습니다");
    const current = await this.dependencies.store.getVersionDetails(context, installation.activeVersionId);
    const target = await this.dependencies.store.getVersionDetails(context, input.targetVersionId);
    if (target.installationId !== installation.installationId)
      throw new Error("rollback target Extension installation이 다릅니다");
    const authorization = await this.dependencies.authorizer.authorize(context, {
      commandId: input.commandId,
      packageName: target.packageName,
      packageVersion: target.packageVersion,
      artifactDigest: target.artifactDigest,
      environment: input.environment,
      riskClass: input.riskClass,
      executionId: input.executionId,
      currentGeneration: installation.activationGeneration,
      currentPermissions: current.permissions,
      nextPermissions: target.permissions,
      ...(input.installApprovalId === undefined ? {} : { installApprovalId: input.installApprovalId }),
      ...(input.permissionApprovalId === undefined ? {} : { permissionApprovalId: input.permissionApprovalId }),
    });
    const archive = await this.dependencies.artifacts.read(context.organizationId, target.artifactDigest);
    const report = await inspectExtensionArchive(archive, { runtime: this.dependencies.runtime });
    return await this.startAndActivate(context, {
      commandId: input.commandId,
      installation,
      version: target,
      reportContributions: contributionIds(report.manifest.contributions),
      versionDirectory: (
        await this.dependencies.artifacts.materialize(context.organizationId, target.artifactDigest, report)
      ).versionDirectory,
      governanceDecisionIds: authorization.decisionIds,
      outcome: "rolled-back",
    });
  }

  public async list(context: TenantContext): Promise<readonly ExtensionInstallationView[]> {
    return await this.dependencies.store.listInstallations(context);
  }

  public async invoke(context: TenantContext, input: InvokeExtensionInput): Promise<unknown> {
    const installation = await this.dependencies.store.findInstallation(context, input.packageName);
    if (!installation?.activeVersionId) throw new Error("active Extension installation이 없습니다");
    const worker = this.activeWorkers.get(activeKey(context.organizationId, installation.installationId));
    if (!worker || worker.versionId !== installation.activeVersionId)
      throw new Error("healthy active Extension worker가 없습니다");
    if (!worker.contributions.includes(input.contribution))
      throw new Error("선언하지 않은 Extension contribution입니다");
    return await worker.handle.invoke(input.contribution, input.payload, input.timeoutMs);
  }

  private async activateArchive(
    context: TenantContext,
    input: ExtensionChangeInput,
    trustLevel: ExtensionTrustLevel,
    sourceKind: "tarball",
  ): Promise<ExtensionActivationView> {
    const report = await inspectExtensionArchive(input.archive, { runtime: this.dependencies.runtime });
    const currentInstallation = await this.dependencies.store.findInstallation(context, report.manifest.name);
    const current = currentInstallation?.activeVersionId
      ? await this.dependencies.store.getVersionDetails(context, currentInstallation.activeVersionId)
      : undefined;
    const authorization = await this.dependencies.authorizer.authorize(context, {
      commandId: input.commandId,
      packageName: report.manifest.name,
      packageVersion: report.manifest.version,
      artifactDigest: report.artifactDigest,
      environment: input.environment,
      riskClass: input.riskClass,
      executionId: input.executionId,
      currentGeneration: currentInstallation?.activationGeneration ?? 0,
      ...(current ? { currentPermissions: current.permissions } : {}),
      nextPermissions: report.manifest.permissions,
      ...(input.installApprovalId === undefined ? {} : { installApprovalId: input.installApprovalId }),
      ...(input.permissionApprovalId === undefined ? {} : { permissionApprovalId: input.permissionApprovalId }),
    });
    const committed = await this.dependencies.artifacts.commit(
      await this.dependencies.artifacts.stage(context.organizationId, report.artifactDigest, input.archive),
    );
    const materialized = await this.dependencies.artifacts.materialize(
      context.organizationId,
      committed.digest,
      report,
    );
    const version = await this.dependencies.store.registerVersion(context, {
      commandId: `${input.commandId}:version`,
      artifact: report,
      trustLevel,
      sourceKind,
    });
    const installation = await this.dependencies.store.findInstallation(context, report.manifest.name);
    if (!installation) throw new Error("Extension installation 등록 결과가 없습니다");
    const details = await this.dependencies.store.getVersionDetails(context, version.versionId);
    return await this.startAndActivate(context, {
      commandId: input.commandId,
      installation,
      version: details,
      reportContributions: contributionIds(report.manifest.contributions),
      versionDirectory: materialized.versionDirectory,
      governanceDecisionIds: authorization.decisionIds,
      outcome: "activated",
    });
  }

  private async startAndActivate(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly installation: ExtensionInstallationView;
      readonly version: ExtensionVersionDetails;
      readonly reportContributions: readonly string[];
      readonly versionDirectory: string;
      readonly governanceDecisionIds: readonly string[];
      readonly outcome: "activated" | "rolled-back";
    },
  ): Promise<ExtensionActivationView> {
    for (const contribution of input.reportContributions) {
      const owner = this.contributionOwners.get(`${context.organizationId}:${contribution}`);
      if (owner && owner !== input.installation.installationId) {
        throw new Error(`Extension contribution ID가 충돌합니다: ${contribution}`);
      }
    }
    const worker = await this.dependencies.workers.start({
      trustLevel: input.version.trustLevel,
      versionDirectory: input.versionDirectory,
      entrypoint: input.version.manifest.runtime.entrypoint,
      manifestDigest: input.version.manifestDigest,
      sdkVersion: "1.0.0",
      contributions: input.reportContributions,
      healthTimeoutMs: input.version.manifest.runtime.healthTimeoutMs,
      stopTimeoutMs: input.version.manifest.runtime.stopTimeoutMs,
    });
    try {
      const activated = await this.dependencies.store.activateVersion(context, {
        commandId: `${input.commandId}:activate`,
        versionId: input.version.versionId,
        expectedGeneration: input.installation.activationGeneration,
        governanceDecisionIds: input.governanceDecisionIds,
        healthReceipt: {
          status: "healthy",
          checkedAt: new Date().toISOString(),
          manifestDigest: input.version.manifestDigest,
        },
        ...(worker.sandboxReceipt === undefined ? {} : { sandboxReceipt: worker.sandboxReceipt }),
        outcome: input.outcome,
      });
      const key = activeKey(context.organizationId, activated.installationId);
      const previous = this.activeWorkers.get(key);
      if (previous) {
        for (const contribution of previous.contributions) {
          this.contributionOwners.delete(`${context.organizationId}:${contribution}`);
        }
      }
      const active: ActiveWorker = {
        organizationId: context.organizationId,
        installationId: activated.installationId,
        versionId: input.version.versionId,
        activationGeneration: activated.activationGeneration,
        contributions: input.reportContributions,
        handle: worker,
      };
      this.activeWorkers.set(key, active);
      for (const contribution of input.reportContributions) {
        this.contributionOwners.set(`${context.organizationId}:${contribution}`, activated.installationId);
      }
      if (previous) await previous.handle.stop().catch(() => undefined);
      return {
        installationId: activated.installationId,
        versionId: input.version.versionId,
        packageName: input.version.packageName,
        packageVersion: input.version.packageVersion,
        artifactDigest: input.version.artifactDigest,
        permissionDigest: input.version.permissionDigest,
        activationGeneration: activated.activationGeneration,
        state: "active",
      };
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }
}
