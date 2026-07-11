import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { EXTENSION_MIGRATIONS } from "./schema.js";
import type { FileArtifactStore } from "./store.js";

interface SessionRecord {
  readonly session_id: string;
  readonly installation_id: string;
  readonly version_id: string;
  readonly lease_expires_at?: string;
}

export interface ExtensionRecoveryAction {
  readonly kind: "session-expired" | "session-restarted" | "staging-quarantined";
  readonly referenceId: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ExtensionRecoveryService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly artifacts: FileArtifactStore,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    artifacts: FileArtifactStore,
  ): Promise<ExtensionRecoveryService> {
    await applyMigrations(database, EXTENSION_MIGRATIONS);
    return new ExtensionRecoveryService(database, organizations, artifacts);
  }

  public async scan(context: TenantContext): Promise<readonly ExtensionRecoveryAction[]> {
    await this.organizations.verifyTenantContext(context);
    const actions: ExtensionRecoveryAction[] = [];
    const [sessions] = await this.database.query<[SessionRecord[]]>(
      "SELECT session_id, installation_id, version_id, lease_expires_at FROM extension_worker_session WHERE organization_id = $organization_id AND state IN ['starting', 'healthy', 'draining'];",
      { organization_id: context.organizationId },
    );
    for (const session of sessions) {
      const expired =
        session.lease_expires_at !== undefined && new Date(session.lease_expires_at).getTime() < Date.now();
      const exitCategory = expired ? "lease-expired" : "host-restarted";
      await this.database.transaction(async (transaction) => {
        await transaction.query(
          "UPDATE extension_worker_session SET state = 'failed', exit_category = $exit_category, error_hash = $error_hash, lease_expires_at = NONE, updated_at = time::now() WHERE organization_id = $organization_id AND session_id = $session_id AND state IN ['starting', 'healthy', 'draining'];",
          {
            organization_id: context.organizationId,
            session_id: session.session_id,
            exit_category: exitCategory,
            error_hash: sha256(exitCategory),
          },
        );
        const payload = JSON.stringify({ sessionId: session.session_id });
        await transaction.query(
          "CREATE extension_event CONTENT { event_id: $event_id, organization_id: $organization_id, installation_id: $installation_id, version_id: $version_id, activation_id: NONE, command_id: $command_id, event_type: 'worker_session_recovered', payload_json: $payload_json, payload_hash: $payload_hash, created_at: time::now() };",
          {
            event_id: randomUUID(),
            organization_id: context.organizationId,
            installation_id: session.installation_id,
            version_id: session.version_id,
            command_id: `recovery:${session.session_id}`,
            payload_json: payload,
            payload_hash: sha256(payload),
          },
        );
      });
      actions.push({ kind: expired ? "session-expired" : "session-restarted", referenceId: session.session_id });
    }
    const quarantined = await this.artifacts.recoverStaging(context.organizationId);
    for (let index = 0; index < quarantined; index += 1) {
      actions.push({ kind: "staging-quarantined", referenceId: `staging-${String(index + 1)}` });
    }
    return actions;
  }
}
