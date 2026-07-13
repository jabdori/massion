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

export interface RegistryExtensionChangeInput extends ExtensionChangeInput {
  readonly trustLevel: "verified" | "community";
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
  readonly sessionId: string;
  readonly contributions: readonly string[];
  readonly handle: ExtensionWorkerHandle;
  readonly previousVersionId?: string;
}

export interface ExtensionWorkerCrashObserver {
  record(input: {
    readonly crashId: string;
    readonly organizationId: string;
    readonly installationId: string;
    readonly versionId: string;
    readonly previousVersionId?: string;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }): Promise<void>;
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
    ["modelEvaluationBundles", contributions.modelEvaluationBundles ?? []],
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
      readonly crashObserver?: ExtensionWorkerCrashObserver;
    },
  ) {}

  public async install(context: TenantContext, input: ExtensionChangeInput): Promise<ExtensionActivationView> {
    return await this.activateArchive(context, input, "untrusted-local", "tarball");
  }

  public async installBundled(context: TenantContext, input: ExtensionChangeInput): Promise<ExtensionActivationView> {
    return await this.activateArchive(context, input, "built-in", "bundled");
  }

  public async installRegistry(
    context: TenantContext,
    input: RegistryExtensionChangeInput,
  ): Promise<ExtensionActivationView> {
    return await this.activateArchive(context, input, input.trustLevel, "registry");
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

  public async recoverActive(
    context: TenantContext,
  ): Promise<{ readonly recovered: number; readonly blocked: number }> {
    let recovered = 0;
    let blocked = 0;
    const installations = await this.dependencies.store.listInstallations(context);
    for (const installation of installations) {
      if (installation.state !== "active" || !installation.activeVersionId) continue;
      const key = activeKey(context.organizationId, installation.installationId);
      if (this.activeWorkers.has(key)) continue;
      let worker: ExtensionWorkerHandle | undefined;
      try {
        const version = await this.dependencies.store.getVersionDetails(context, installation.activeVersionId);
        const archive = await this.dependencies.artifacts.read(context.organizationId, version.artifactDigest);
        const report = await inspectExtensionArchive(archive, { runtime: this.dependencies.runtime });
        const contributions = contributionIds(report.manifest.contributions);
        this.assertContributionOwnership(context.organizationId, installation.installationId, contributions);
        const materialized = await this.dependencies.artifacts.materialize(
          context.organizationId,
          version.artifactDigest,
          report,
        );
        worker = await this.dependencies.workers.start({
          trustLevel: version.trustLevel,
          versionDirectory: materialized.versionDirectory,
          entrypoint: version.manifest.runtime.entrypoint,
          manifestDigest: version.manifestDigest,
          sdkVersion: "1.0.0",
          contributions,
          healthTimeoutMs: version.manifest.runtime.healthTimeoutMs,
          stopTimeoutMs: version.manifest.runtime.stopTimeoutMs,
        });
        const session = await this.dependencies.store.recordWorkerSession(context, {
          installationId: installation.installationId,
          versionId: version.versionId,
          activationGeneration: installation.activationGeneration,
          processId: worker.processId,
          ...(worker.sandboxReceipt === undefined ? {} : { sandboxReceipt: worker.sandboxReceipt }),
        });
        this.registerActiveWorker(context.organizationId, {
          organizationId: context.organizationId,
          installationId: installation.installationId,
          versionId: version.versionId,
          activationGeneration: installation.activationGeneration,
          sessionId: session.sessionId,
          contributions,
          handle: worker,
        });
        recovered += 1;
      } catch {
        worker?.terminate();
        blocked += 1;
      }
    }
    return { recovered, blocked };
  }

  private async activateArchive(
    context: TenantContext,
    input: ExtensionChangeInput,
    trustLevel: ExtensionTrustLevel,
    sourceKind: "tarball" | "bundled" | "registry",
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
    this.assertContributionOwnership(
      context.organizationId,
      input.installation.installationId,
      input.reportContributions,
    );
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
      const session = await this.dependencies.store.recordWorkerSession(context, {
        installationId: activated.installationId,
        versionId: input.version.versionId,
        activationGeneration: activated.activationGeneration,
        processId: worker.processId,
        ...(worker.sandboxReceipt === undefined ? {} : { sandboxReceipt: worker.sandboxReceipt }),
      });
      const key = activeKey(context.organizationId, activated.installationId);
      const previous = this.activeWorkers.get(key);
      const active: ActiveWorker = {
        organizationId: context.organizationId,
        installationId: activated.installationId,
        versionId: input.version.versionId,
        activationGeneration: activated.activationGeneration,
        sessionId: session.sessionId,
        contributions: input.reportContributions,
        handle: worker,
        ...(input.installation.activeVersionId === undefined
          ? {}
          : { previousVersionId: input.installation.activeVersionId }),
      };
      this.registerActiveWorker(context.organizationId, active);
      void worker.exited
        ?.then(async (exit) => {
          if (this.activeWorkers.get(key)?.handle !== worker) return;
          this.removeActiveWorker(active);
          await this.dependencies.store.finishWorkerSession(context, session.sessionId, {
            state: "failed",
            exitCategory: "unexpected-exit",
          });
          await this.dependencies.crashObserver?.record({
            crashId: `${session.sessionId}:${String(exit.code)}:${exit.signal ?? "none"}`,
            organizationId: context.organizationId,
            installationId: activated.installationId,
            versionId: input.version.versionId,
            ...(active.previousVersionId === undefined ? {} : { previousVersionId: active.previousVersionId }),
            code: exit.code,
            signal: exit.signal,
          });
        })
        .catch(() => undefined);
      if (previous) {
        try {
          await previous.handle.stop();
          await this.dependencies.store.finishWorkerSession(context, previous.sessionId, {
            state: "stopped",
            exitCategory: "version-replaced",
          });
        } catch {
          await this.dependencies.store.finishWorkerSession(context, previous.sessionId, {
            state: "failed",
            exitCategory: "stop-failed",
          });
        }
      }
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

  private assertContributionOwnership(
    organizationId: string,
    installationId: string,
    contributions: readonly string[],
  ): void {
    for (const contribution of contributions) {
      const owner = this.contributionOwners.get(`${organizationId}:${contribution}`);
      if (owner && owner !== installationId) {
        throw new Error(`Extension contribution ID가 충돌합니다: ${contribution}`);
      }
    }
  }

  private registerActiveWorker(organizationId: string, active: ActiveWorker): void {
    const key = activeKey(organizationId, active.installationId);
    const previous = this.activeWorkers.get(key);
    if (previous) {
      for (const contribution of previous.contributions) {
        this.contributionOwners.delete(`${organizationId}:${contribution}`);
      }
    }
    this.activeWorkers.set(key, active);
    for (const contribution of active.contributions) {
      this.contributionOwners.set(`${organizationId}:${contribution}`, active.installationId);
    }
  }

  private removeActiveWorker(active: ActiveWorker): void {
    const key = activeKey(active.organizationId, active.installationId);
    if (this.activeWorkers.get(key)?.handle !== active.handle) return;
    this.activeWorkers.delete(key);
    for (const contribution of active.contributions) {
      this.contributionOwners.delete(`${active.organizationId}:${contribution}`);
    }
  }
}
