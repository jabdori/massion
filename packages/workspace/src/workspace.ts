import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { WORKSPACE_MIGRATION } from "./schema.js";

export type WorkspaceKind = "local-directory";
export type WorkspaceTrust = "pending" | "trusted" | "blocked";
export type WorkspaceStatus = "active" | "archived";

interface WorkspaceRow {
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: WorkspaceKind;
  readonly trust: WorkspaceTrust;
  readonly status: WorkspaceStatus;
  readonly revision: number;
  readonly created_at: unknown;
  readonly last_used_at: unknown;
}

export interface WorkspaceView {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly path: string;
  readonly kind: WorkspaceKind;
  readonly trust: WorkspaceTrust;
  readonly status: WorkspaceStatus;
  readonly revision: number;
  readonly createdAt: unknown;
  readonly lastUsedAt: unknown;
}

export interface RegisterWorkspaceInput {
  readonly path: string;
  readonly name?: string;
}

export interface TrustDecisionInput {
  readonly workspaceId: string;
  readonly decision: Exclude<WorkspaceTrust, "pending">;
  readonly expectedRevision: number;
}

export interface ArchiveWorkspaceInput {
  readonly workspaceId: string;
  readonly expectedRevision: number;
}

function view(row: WorkspaceRow): WorkspaceView {
  return {
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
    name: row.name,
    path: row.path,
    kind: row.kind,
    trust: row.trust,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) throw new Error("Workspace 경로는 절대 경로여야 합니다");
  const segments = trimmed.split("/");
  if (segments.includes("..")) throw new Error("Workspace 경로에 상위 디렉토리 참조를 쓸 수 없습니다");
  const normalized = trimmed.replace(/\/+$/u, "");
  return normalized === "" ? "/" : normalized;
}

function defaultName(path: string): string {
  const segment = path.split("/").filter(Boolean).at(-1);
  return segment ?? path;
}

async function findById(
  executor: QueryExecutor,
  context: TenantContext,
  workspaceId: string,
): Promise<WorkspaceRow | undefined> {
  const [rows] = await executor.query<[WorkspaceRow[]]>(
    `SELECT * FROM workspace
     WHERE workspace_id = $workspace_id AND organization_id = $organization_id
     LIMIT 1;`,
    { workspace_id: workspaceId, organization_id: context.organizationId },
  );
  return rows[0];
}

export class WorkspaceService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<WorkspaceService> {
    await applyMigrations(database, [WORKSPACE_MIGRATION]);
    return new WorkspaceService(database, organizations);
  }

  public async register(context: TenantContext, input: RegisterWorkspaceInput): Promise<WorkspaceView> {
    const path = normalizePath(input.path);
    const name = input.name?.trim() || defaultName(path);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const [existingRows] = await transaction.query<[WorkspaceRow[]]>(
        "SELECT * FROM workspace WHERE organization_id = $organization_id AND path = $path LIMIT 1;",
        { organization_id: context.organizationId, path },
      );
      const existing = existingRows[0];
      if (existing) {
        if (existing.status === "active") return view(existing);
        const [revived] = await transaction.query<[WorkspaceRow[]]>(
          `UPDATE workspace
           SET status = 'active', trust = 'pending', revision += 1, last_used_at = time::now()
           WHERE workspace_id = $workspace_id AND organization_id = $organization_id
           RETURN AFTER;`,
          { workspace_id: existing.workspace_id, organization_id: context.organizationId },
        );
        if (!revived[0]) throw new Error("Workspace 재활성화 결과가 없습니다");
        return view(revived[0]);
      }
      const [created] = await transaction.query<[WorkspaceRow[]]>(
        `CREATE workspace CONTENT {
          workspace_id: $workspace_id,
          organization_id: $organization_id,
          name: $name,
          path: $path,
          kind: 'local-directory',
          trust: 'pending',
          status: 'active',
          revision: 0,
          created_at: time::now(),
          last_used_at: time::now()
        } RETURN AFTER;`,
        { workspace_id: randomUUID(), organization_id: context.organizationId, name, path },
      );
      if (!created[0]) throw new Error("Workspace 생성 결과가 없습니다");
      return view(created[0]);
    });
  }

  public async list(context: TenantContext): Promise<readonly WorkspaceView[]> {
    await this.organizations.verifyTenantContext(context);
    const [rows] = await this.database.query<[WorkspaceRow[]]>(
      `SELECT * FROM workspace
       WHERE organization_id = $organization_id AND status = 'active'
       ORDER BY last_used_at DESC;`,
      { organization_id: context.organizationId },
    );
    return rows.map(view);
  }

  public async get(context: TenantContext, workspaceId: string): Promise<WorkspaceView> {
    await this.organizations.verifyTenantContext(context);
    const row = await findById(this.database, context, workspaceId);
    if (!row) throw new Error("Workspace를 찾을 수 없습니다");
    return view(row);
  }

  public async decideTrust(context: TenantContext, input: TrustDecisionInput): Promise<WorkspaceView> {
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], transaction);
      const target = await findById(transaction, context, input.workspaceId);
      if (!target) throw new Error("Workspace를 찾을 수 없습니다");
      const [updated] = await transaction.query<[WorkspaceRow[]]>(
        `UPDATE workspace
         SET trust = $decision, revision += 1
         WHERE workspace_id = $workspace_id AND organization_id = $organization_id AND revision = $expected_revision
         RETURN AFTER;`,
        {
          workspace_id: input.workspaceId,
          organization_id: context.organizationId,
          decision: input.decision,
          expected_revision: input.expectedRevision,
        },
      );
      if (!updated[0]) throw new Error("Workspace revision이 일치하지 않습니다");
      return view(updated[0]);
    });
  }

  public async touch(context: TenantContext, workspaceId: string): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    const [updated] = await this.database.query<[WorkspaceRow[]]>(
      `UPDATE workspace
       SET last_used_at = time::now()
       WHERE workspace_id = $workspace_id AND organization_id = $organization_id AND status = 'active'
       RETURN AFTER;`,
      { workspace_id: workspaceId, organization_id: context.organizationId },
    );
    if (!updated[0]) throw new Error("Workspace를 찾을 수 없습니다");
  }

  public async archive(context: TenantContext, input: ArchiveWorkspaceInput): Promise<WorkspaceView> {
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], transaction);
      const target = await findById(transaction, context, input.workspaceId);
      if (!target) throw new Error("Workspace를 찾을 수 없습니다");
      const [updated] = await transaction.query<[WorkspaceRow[]]>(
        `UPDATE workspace
         SET status = 'archived', revision += 1
         WHERE workspace_id = $workspace_id AND organization_id = $organization_id AND revision = $expected_revision
         RETURN AFTER;`,
        {
          workspace_id: input.workspaceId,
          organization_id: context.organizationId,
          expected_revision: input.expectedRevision,
        },
      );
      if (!updated[0]) throw new Error("Workspace revision이 일치하지 않습니다");
      return view(updated[0]);
    });
  }
}
