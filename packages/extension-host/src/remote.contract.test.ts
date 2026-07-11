import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityService, OrganizationService } from "@massion/identity";
import {
  ApprovalStore,
  EmergencyControl,
  GovernanceApprovalRequiredError,
  GovernanceGate,
  GovernanceService,
  PermitStore,
  PolicyStore,
  createDefaultPolicy,
} from "@massion/governance";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { ExtensionComplianceAuditor } from "./compliance.js";
import { ExtensionGovernanceAdapter } from "./governance-adapter.js";
import { ExtensionLifecycleService, type ExtensionWorkerLauncher } from "./lifecycle.js";
import { ExtensionRecoveryService } from "./recovery.js";
import { makeTar, validManifest, validPackage } from "./test-helpers.js";
import { ExtensionStore, FileArtifactStore } from "./store.js";
import type { ExtensionWorkerHandle } from "./worker-supervisor.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

async function provision(databaseName: string): Promise<void> {
  await using admin = await createDatabase({
    url: remoteUrl ?? "",
    namespace: "main",
    database: "main",
    authentication: { username: "root", password: "root" },
  });
  await admin.query(`DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`);
}

function archive(version: string): Buffer {
  return makeTar([
    { path: "package/package.json", body: JSON.stringify({ ...validPackage, version }) },
    {
      path: "package/massion.extension.json",
      body: JSON.stringify({ ...validManifest, version }),
    },
    { path: "package/dist/worker.js", body: "export {};" },
    { path: "package/README.md", body: "# Remote" },
    { path: "package/LICENSE", body: "Apache-2.0" },
  ]);
}

class RemoteWorker implements ExtensionWorkerHandle {
  public readonly processId = 4242;
  public readonly sandboxReceipt = {
    backendId: "remote-contract-sandbox",
    backendVersion: "1.0.0",
    policyDigest: "d".repeat(64),
    processId: 4242,
    appliedAt: new Date().toISOString(),
  };
  public async invoke(): Promise<unknown> {
    return { ok: true };
  }
  public async stop(): Promise<void> {}
  public terminate(): void {}
}

describe("remote Extension Host contract", () => {
  remoteTest("SurrealDB 3.2.x에서 tenant·activation·rollback·restore 계약을 보존한다", async () => {
    const databaseName = `extension_${crypto.randomUUID().replaceAll("-", "")}`;
    await provision(databaseName);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: `${databaseName}@example.com`,
      displayName: "Extension Remote",
    });
    const other = await identities.registerPersonalUser({
      email: `${databaseName}-other@example.com`,
      displayName: "Other",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const governed = new ExtensionGovernanceAdapter(new GovernanceGate(governance, approvals, permits, emergency));
    const defaults = createDefaultPolicy("personal");
    const reviewDraft = await policies.createDraft(context, {
      commandId: "remote-extension-review-policy",
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    const reviewPolicy = await policies.activate(context, {
      commandId: "remote-extension-review-activate",
      policyVersionId: reviewDraft.policy_version_id,
    });
    const governedInput = {
      commandId: "remote-governed-review",
      packageName: "@massion-ext/echo",
      packageVersion: "1.0.0",
      artifactDigest: "a".repeat(64),
      environment: "remote",
      riskClass: "extension-install",
      executionId: "remote-governed-surface",
      currentGeneration: 0,
      nextPermissions: validManifest.permissions,
    } as const;
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await governed.authorize(context, governedInput);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("원격 Extension review 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: "remote-extension-review-vote",
      approvalId: required.approvalId,
      vote: "approve",
      reason: "remote contract review",
    });
    await expect(
      governed.authorize(context, { ...governedInput, installApprovalId: required.approvalId }),
    ).resolves.toMatchObject({ decisionIds: [required.decisionId] });
    const administeredPolicies = await PolicyStore.create(
      database,
      organizations,
      new GovernanceGate(governance, approvals, permits, emergency),
    );
    const autoDraft = await administeredPolicies.createDraft(context, {
      commandId: "remote-extension-auto-policy",
      bundle: defaults.bundle,
      requirements: [],
    });
    let policyRequired: GovernanceApprovalRequiredError | undefined;
    try {
      await administeredPolicies.activate(context, {
        commandId: "remote-extension-auto-activate",
        policyVersionId: autoDraft.policy_version_id,
        expectedActivePolicyVersionId: reviewPolicy.policy_version_id,
      });
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) policyRequired = error;
      else throw error;
    }
    if (!policyRequired) throw new Error("원격 Extension auto 정책 활성화 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: "remote-extension-auto-policy-vote",
      approvalId: policyRequired.approvalId,
      vote: "approve",
      reason: "enable extension auto policy",
    });
    await administeredPolicies.activate(context, {
      commandId: "remote-extension-auto-activate",
      policyVersionId: autoDraft.policy_version_id,
      expectedActivePolicyVersionId: reviewPolicy.policy_version_id,
      governanceApprovalId: policyRequired.approvalId,
    });
    await expect(
      governed.authorize(context, {
        ...governedInput,
        commandId: "remote-governed-auto",
        currentPermissions: validManifest.permissions,
        nextPermissions: {
          ...validManifest.permissions,
          network: [{ origin: "https://api.example.com", methods: ["GET"] }],
        },
      }),
    ).resolves.toMatchObject({ decisionIds: expect.any(Array) });
    const store = await ExtensionStore.create(database, organizations);
    const root = await mkdtemp(join(tmpdir(), "massion-extension-remote-"));
    const artifacts = new FileArtifactStore(root);
    let failNext = false;
    const workers: ExtensionWorkerLauncher = {
      async start() {
        if (failNext) {
          failNext = false;
          throw new Error("remote health failed");
        }
        return new RemoteWorker();
      },
    };
    const lifecycle = new ExtensionLifecycleService({
      runtime: { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" },
      store,
      artifacts,
      authorizer: {
        authorize: async (_context, input) => ({
          decisionIds: [`remote-decision:${input.commandId}`],
          permissionDiff: {
            increased: false,
            reasons: [],
            beforeDigest: "a".repeat(64),
            afterDigest: "b".repeat(64),
          },
        }),
      },
      workers,
    });
    try {
      const first = await lifecycle.install(context, {
        commandId: "remote-install-v1",
        archive: archive("1.0.0"),
        environment: "remote",
        riskClass: "extension-install",
        executionId: "remote-surface-1",
      });
      expect(await lifecycle.list(otherContext)).toEqual([]);
      await expect(store.getVersion(otherContext, first.versionId)).rejects.toThrow("찾을 수 없습니다");

      failNext = true;
      await expect(
        lifecycle.update(context, {
          commandId: "remote-update-failed",
          archive: archive("1.1.0"),
          environment: "remote",
          riskClass: "extension-update",
          executionId: "remote-surface-2",
        }),
      ).rejects.toThrow("remote health failed");
      expect(await store.findInstallation(context, "@massion-ext/echo")).toMatchObject({
        activeVersionId: first.versionId,
        activationGeneration: 1,
      });

      const second = await lifecycle.update(context, {
        commandId: "remote-update-v2",
        archive: archive("1.2.0"),
        environment: "remote",
        riskClass: "extension-update",
        executionId: "remote-surface-3",
      });
      const rolledBack = await lifecycle.rollback(context, {
        commandId: "remote-rollback-v1",
        packageName: "@massion-ext/echo",
        targetVersionId: first.versionId,
        environment: "remote",
        riskClass: "extension-rollback",
        executionId: "remote-surface-4",
      });
      expect(rolledBack.activationGeneration).toBe(second.activationGeneration + 1);

      const recovery = await ExtensionRecoveryService.create(database, organizations, artifacts);
      expect((await recovery.scan(context)).some((action) => action.kind === "session-restarted")).toBe(true);
      const restarted = new ExtensionLifecycleService({
        runtime: { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" },
        store,
        artifacts,
        authorizer: {
          authorize: async (_context, input) => ({
            decisionIds: [`remote-restart:${input.commandId}`],
            permissionDiff: {
              increased: false,
              reasons: [],
              beforeDigest: "a".repeat(64),
              afterDigest: "b".repeat(64),
            },
          }),
        },
        workers,
      });
      await expect(restarted.recoverActive(context)).resolves.toEqual({ recovered: 1, blocked: 0 });
      await expect(
        restarted.invoke(context, {
          packageName: "@massion-ext/echo",
          contribution: "runtimeTools:echo",
          payload: { restored: true },
          timeoutMs: 1_000,
        }),
      ).resolves.toEqual({ ok: true });

      const auditor = await ExtensionComplianceAuditor.create(database, organizations, artifacts);
      await expect(auditor.assertCompliant(context)).resolves.toBeUndefined();
      const targetName = `extension_restore_${crypto.randomUUID().replaceAll("-", "")}`;
      await provision(targetName);
      await using target = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "massion",
        database: targetName,
        authentication: { username: "root", password: "root" },
      });
      const details = await store.getVersionDetails(context, first.versionId);
      const exported = await database.exportSql();
      const corrupted = exported.replace(details.permissionDigest, "c".repeat(64));
      expect(corrupted).not.toBe(exported);
      await target.importSql(corrupted);
      const targetOrganizations = await OrganizationService.create(target);
      const targetAuditor = await ExtensionComplianceAuditor.create(target, targetOrganizations, artifacts);
      await expect(targetAuditor.assertCompliant(context)).rejects.toThrow("permission");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
