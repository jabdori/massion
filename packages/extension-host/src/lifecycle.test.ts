import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthorizeExtensionChangeInput } from "./governance-adapter.js";
import {
  ExtensionLifecycleService,
  type ExtensionLifecycleAuthorizer,
  type ExtensionWorkerLauncher,
} from "./lifecycle.js";
import { makeTar, validManifest, validPackage } from "./test-helpers.js";
import { FileArtifactStore, ExtensionStore } from "./store.js";
import type { ExtensionWorkerHandle, StartExtensionWorkerInput } from "./worker-supervisor.js";

function versionTar(
  version: string,
  options: {
    readonly packageName?: `@massion-ext/${string}`;
    readonly contribution?: string;
    readonly growthSignal?: string;
    readonly growthTarget?: string;
    readonly network?: readonly { readonly origin: string; readonly methods: readonly ["GET"] }[];
  } = {},
): Buffer {
  const packageName = options.packageName ?? "@massion-ext/echo";
  const manifest = {
    ...validManifest,
    name: packageName,
    version,
    permissions: { ...validManifest.permissions, network: options.network ?? [] },
    contributions: {
      ...validManifest.contributions,
      runtimeTools: [{ id: options.contribution ?? "echo", handler: options.contribution ?? "echo" }],
      growthSignals:
        options.growthSignal === undefined
          ? validManifest.contributions.growthSignals
          : [{ id: options.growthSignal, handler: options.growthSignal }],
      growthTargets:
        options.growthTarget === undefined
          ? validManifest.contributions.growthTargets
          : [{ id: options.growthTarget, handler: options.growthTarget }],
    },
  };
  const packageJson = { ...validPackage, name: packageName, version };
  return makeTar([
    { path: "package/package.json", body: JSON.stringify(packageJson) },
    { path: "package/massion.extension.json", body: JSON.stringify(manifest) },
    { path: "package/dist/worker.js", body: "export {};" },
    { path: "package/README.md", body: "# Extension" },
    { path: "package/LICENSE", body: "Apache-2.0" },
  ]);
}

class AllowLifecycleAuthorizer implements ExtensionLifecycleAuthorizer {
  public readonly calls: AuthorizeExtensionChangeInput[] = [];
  public async authorize(_context: TenantContext, input: AuthorizeExtensionChangeInput) {
    this.calls.push(input);
    return {
      decisionIds: [`decision-${input.commandId}`],
      permissionDiff: {
        increased: Boolean(input.currentPermissions && input.nextPermissions.network.length > 0),
        reasons: [],
        beforeDigest: "a".repeat(64),
        afterDigest: "b".repeat(64),
      },
    };
  }
}

class FakeWorker implements ExtensionWorkerHandle {
  public stopped = false;
  public terminated = false;
  public readonly processId = 100;
  public async invoke(contribution: string, input: unknown): Promise<unknown> {
    return { contribution, input };
  }
  public async stop(): Promise<void> {
    this.stopped = true;
  }
  public terminate(): void {
    this.terminated = true;
  }
}

class FakeWorkerLauncher implements ExtensionWorkerLauncher {
  public readonly inputs: StartExtensionWorkerInput[] = [];
  public readonly workers: FakeWorker[] = [];
  public failNext = false;
  public async start(input: StartExtensionWorkerInput): Promise<ExtensionWorkerHandle> {
    this.inputs.push(input);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("health failed");
    }
    const worker = new FakeWorker();
    this.workers.push(worker);
    return worker;
  }
}

describe("ExtensionLifecycleService", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: ExtensionStore;
  let artifacts: FileArtifactStore;
  let authorizer: AllowLifecycleAuthorizer;
  let launcher: FakeWorkerLauncher;
  let lifecycle: ExtensionLifecycleService;
  let root: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "lifecycle@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await ExtensionStore.create(database, organizations);
    root = await mkdtemp(join(tmpdir(), "massion-lifecycle-"));
    artifacts = new FileArtifactStore(root);
    authorizer = new AllowLifecycleAuthorizer();
    launcher = new FakeWorkerLauncher();
    lifecycle = new ExtensionLifecycleService({
      runtime: { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" },
      store,
      artifacts,
      authorizer,
      workers: launcher,
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("inspect→authorize→materialize→health→activate 순서로 첫 version을 설치한다", async () => {
    const activated = await lifecycle.install(context, {
      commandId: "install-v1",
      archive: versionTar("1.0.0"),
      environment: "local",
      riskClass: "extension-install",
      executionId: "surface-1",
    });

    expect(activated).toMatchObject({
      packageName: "@massion-ext/echo",
      packageVersion: "1.0.0",
      activationGeneration: 1,
      state: "active",
    });
    expect(authorizer.calls).toHaveLength(1);
    expect(launcher.inputs[0]?.versionDirectory).not.toContain("staging");
    expect(JSON.stringify(activated)).not.toContain(root);
  });

  it("bundled 공식 Extension도 검사·승인·health를 거쳐 built-in으로 설치한다", async () => {
    const activated = await lifecycle.installBundled(context, {
      commandId: "install-bundled",
      archive: versionTar("1.0.0"),
      environment: "local",
      riskClass: "extension-install",
      executionId: "surface-bundled",
    });

    expect(launcher.inputs[0]?.trustLevel).toBe("built-in");
    await expect(store.getVersionDetails(context, activated.versionId)).resolves.toMatchObject({
      trustLevel: "built-in",
      sourceKind: "bundled",
    });
    expect(authorizer.calls).toHaveLength(1);
  });

  it("update health 실패 시 이전 active worker와 pointer를 유지한다", async () => {
    const first = await lifecycle.install(context, {
      commandId: "install-before-failure",
      archive: versionTar("1.0.0"),
      environment: "local",
      riskClass: "extension-install",
      executionId: "surface-1",
    });
    launcher.failNext = true;

    await expect(
      lifecycle.update(context, {
        commandId: "update-health-failure",
        archive: versionTar("1.1.0", {
          network: [{ origin: "https://api.example.com", methods: ["GET"] }],
        }),
        environment: "local",
        riskClass: "extension-update",
        executionId: "surface-2",
      }),
    ).rejects.toThrow("health failed");

    expect(await store.findInstallation(context, "@massion-ext/echo")).toMatchObject({
      activeVersionId: first.versionId,
      activationGeneration: 1,
    });
    expect(launcher.workers[0]?.stopped).toBe(false);
  });

  it("성공 update는 pointer를 바꾼 뒤 이전 worker를 drain하고 healthy version으로 rollback한다", async () => {
    const first = await lifecycle.install(context, {
      commandId: "install-for-rollback",
      archive: versionTar("1.0.0"),
      environment: "local",
      riskClass: "extension-install",
      executionId: "surface-1",
    });
    const second = await lifecycle.update(context, {
      commandId: "update-v2",
      archive: versionTar("1.1.0"),
      environment: "local",
      riskClass: "extension-update",
      executionId: "surface-2",
    });
    expect(second.activationGeneration).toBe(2);
    expect(launcher.workers[0]?.stopped).toBe(true);

    const rolledBack = await lifecycle.rollback(context, {
      commandId: "rollback-v1",
      packageName: "@massion-ext/echo",
      targetVersionId: first.versionId,
      environment: "local",
      riskClass: "extension-rollback",
      executionId: "surface-3",
    });
    expect(rolledBack).toMatchObject({ versionId: first.versionId, activationGeneration: 3 });
    expect(launcher.workers[1]?.stopped).toBe(true);
  });

  it("다른 installation의 contribution ID 충돌은 activation 전에 차단한다", async () => {
    await lifecycle.install(context, {
      commandId: "install-contribution-owner",
      archive: versionTar("1.0.0", { contribution: "shared" }),
      environment: "local",
      riskClass: "extension-install",
      executionId: "surface-1",
    });
    await expect(
      lifecycle.install(context, {
        commandId: "install-contribution-conflict",
        archive: versionTar("1.0.0", { packageName: "@massion-ext/other", contribution: "shared" }),
        environment: "local",
        riskClass: "extension-install",
        executionId: "surface-2",
      }),
    ).rejects.toThrow("contribution");
    expect(await store.findInstallation(context, "@massion-ext/other")).toMatchObject({ activationGeneration: 0 });
  });

  it("선언된 Growth signal과 target contribution을 같은 격리 RPC 경계로 호출한다", async () => {
    await lifecycle.install(context, {
      commandId: "install-growth-adapter",
      archive: versionTar("1.0.0", { growthSignal: "quality", growthTarget: "prompt" }),
      environment: "local",
      riskClass: "extension-install",
      executionId: "surface-growth",
    });

    await expect(
      lifecycle.invoke(context, {
        packageName: "@massion-ext/echo",
        contribution: "growthSignals:quality",
        payload: { suggestionId: "suggestion-1" },
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ contribution: "growthSignals:quality" });
    await expect(
      lifecycle.invoke(context, {
        packageName: "@massion-ext/echo",
        contribution: "growthTargets:prompt",
        payload: { operation: "inspect" },
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ contribution: "growthTargets:prompt" });
  });

  it("AgentOS 재시작 후 active pointer에서 worker와 contribution registry를 재구성한다", async () => {
    await lifecycle.install(context, {
      commandId: "install-before-restart",
      archive: versionTar("1.0.0"),
      environment: "local",
      riskClass: "extension-install",
      executionId: "surface-restart-1",
    });
    const restartedLauncher = new FakeWorkerLauncher();
    const restarted = new ExtensionLifecycleService({
      runtime: { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" },
      store,
      artifacts,
      authorizer,
      workers: restartedLauncher,
    });

    expect(await restarted.recoverActive(context)).toEqual({ recovered: 1, blocked: 0 });
    await expect(
      restarted.invoke(context, {
        packageName: "@massion-ext/echo",
        contribution: "runtimeTools:echo",
        payload: { after: "restart" },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ contribution: "runtimeTools:echo", input: { after: "restart" } });
    const [sessions] = await database.query<
      [Array<{ state: string; activation_generation: number; started_at: string }>]
    >(
      "SELECT state, activation_generation, started_at FROM extension_worker_session WHERE organization_id = $organization_id ORDER BY started_at ASC;",
      { organization_id: context.organizationId },
    );
    expect(sessions.at(-1)).toMatchObject({ state: "healthy", activation_generation: 1 });
  });
});
