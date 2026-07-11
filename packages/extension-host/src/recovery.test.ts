import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectExtensionArchive } from "./artifact-inspector.js";
import { ExtensionRecoveryService } from "./recovery.js";
import { ExtensionStore, FileArtifactStore, type ExtensionVersionView } from "./store.js";
import { validTar } from "./test-helpers.js";

describe("ExtensionRecoveryService", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let artifacts: FileArtifactStore;
  let version: ExtensionVersionView;
  let root: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "recovery@example.com", displayName: "Recovery" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ExtensionStore.create(database, organizations);
    const archive = validTar();
    const report = await inspectExtensionArchive(archive, {
      runtime: { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" },
    });
    version = await store.registerVersion(context, {
      commandId: "recovery-version",
      artifact: report,
      trustLevel: "built-in",
      sourceKind: "bundled",
    });
    root = await mkdtemp(join(tmpdir(), "massion-recovery-"));
    artifacts = new FileArtifactStore(root);
    await artifacts.stage(context.organizationId, report.artifactDigest, archive);
  });
  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("만료된 worker lease를 failed로 전이하고 미완료 staging을 quarantine한다", async () => {
    await database.query(
      "CREATE extension_worker_session CONTENT { session_id: 'session-expired', organization_id: $organization_id, installation_id: $installation_id, version_id: $version_id, activation_generation: 1, state: 'starting', protocol_version: 'massion.extension.rpc.v1', process_id: NONE, sandbox_receipt_json: NONE, lease_expires_at: time::now() - 1h, exit_category: NONE, error_hash: NONE, started_at: time::now() - 2h, updated_at: time::now() - 2h };",
      {
        organization_id: context.organizationId,
        installation_id: version.installationId,
        version_id: version.versionId,
      },
    );
    const recovery = await ExtensionRecoveryService.create(database, organizations, artifacts);

    const actions = await recovery.scan(context);

    expect(actions.map((action) => action.kind)).toEqual(["session-expired", "staging-quarantined"]);
    const [sessions] = await database.query<[Array<{ state: string; exit_category?: string }>]>(
      "SELECT state, exit_category FROM extension_worker_session WHERE session_id = 'session-expired';",
    );
    expect(sessions[0]).toMatchObject({ state: "failed", exit_category: "lease-expired" });
  });

  it("재시작 때 lease가 없는 기존 healthy session도 stale 상태로 종료한다", async () => {
    await database.query(
      "CREATE extension_worker_session CONTENT { session_id: 'session-before-restart', organization_id: $organization_id, installation_id: $installation_id, version_id: $version_id, activation_generation: 1, state: 'healthy', protocol_version: 'massion.extension.rpc.v1', process_id: 101, sandbox_receipt_json: NONE, lease_expires_at: NONE, exit_category: NONE, error_hash: NONE, started_at: time::now() - 1h, updated_at: time::now() - 1h };",
      {
        organization_id: context.organizationId,
        installation_id: version.installationId,
        version_id: version.versionId,
      },
    );
    const recovery = await ExtensionRecoveryService.create(database, organizations, artifacts);

    expect(await recovery.scan(context)).toContainEqual({
      kind: "session-restarted",
      referenceId: "session-before-restart",
    });
    const [sessions] = await database.query<[Array<{ state: string; exit_category: string }>]>(
      "SELECT state, exit_category FROM extension_worker_session WHERE session_id = 'session-before-restart';",
    );
    expect(sessions[0]).toEqual({ state: "failed", exit_category: "host-restarted" });
  });
});
