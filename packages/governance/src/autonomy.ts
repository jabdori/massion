import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, defineMigration, type MassionDatabase } from "@massion/storage";

// 자율성 다이얼: 조직 단위 실행 승인 모드입니다. 정책 상한 원칙에 따라 이 설정은
// 승인 요구를 "추가"만 할 수 있고(review), 정책·불변식이 요구한 승인을 없애지 못합니다.
export type AutonomyMode = "automatic" | "review";

export interface AutonomyState {
  readonly mode: AutonomyMode;
  readonly revision: number;
}

export const GOVERNANCE_AUTONOMY_MIGRATION = defineMigration(
  "0108-governance-autonomy",
  `
DEFINE TABLE governance_autonomy SCHEMAFULL;
DEFINE FIELD autonomy_id ON governance_autonomy TYPE string;
DEFINE FIELD organization_id ON governance_autonomy TYPE string;
DEFINE FIELD mode ON governance_autonomy TYPE string ASSERT $value IN ["automatic", "review"];
DEFINE FIELD revision ON governance_autonomy TYPE int ASSERT $value >= 1;
DEFINE FIELD updated_at ON governance_autonomy TYPE datetime;
DEFINE INDEX governance_autonomy_id ON governance_autonomy FIELDS autonomy_id UNIQUE;
DEFINE INDEX governance_autonomy_organization ON governance_autonomy FIELDS organization_id UNIQUE;
`,
);

interface AutonomyRecord {
  readonly organization_id: string;
  readonly mode: AutonomyMode;
  readonly revision: number;
}

export class AutonomyStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<AutonomyStore> {
    await applyMigrations(database, [GOVERNANCE_AUTONOMY_MIGRATION]);
    return new AutonomyStore(database, organizations);
  }

  public async get(context: TenantContext): Promise<AutonomyState> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[AutonomyRecord[]]>(
      "SELECT organization_id, mode, revision FROM governance_autonomy WHERE organization_id = $organization_id LIMIT 1;",
      { organization_id: context.organizationId },
    );
    const record = records[0];
    return record ? { mode: record.mode, revision: record.revision } : { mode: "automatic", revision: 0 };
  }

  public async set(
    context: TenantContext,
    input: { readonly mode: AutonomyMode; readonly expectedRevision: number },
  ): Promise<AutonomyState> {
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], transaction);
      const [records] = await transaction.query<[AutonomyRecord[]]>(
        "SELECT organization_id, mode, revision FROM governance_autonomy WHERE organization_id = $organization_id LIMIT 1;",
        { organization_id: context.organizationId },
      );
      const current = records[0];
      if (!current) {
        if (input.expectedRevision !== 0) throw new Error("자율성 모드 revision이 일치하지 않습니다");
        const [created] = await transaction.query<[AutonomyRecord[]]>(
          `CREATE governance_autonomy CONTENT {
            autonomy_id: $autonomy_id,
            organization_id: $organization_id,
            mode: $mode,
            revision: 1,
            updated_at: time::now()
          } RETURN AFTER;`,
          { autonomy_id: randomUUID(), organization_id: context.organizationId, mode: input.mode },
        );
        if (!created[0]) throw new Error("자율성 모드 생성 결과가 없습니다");
        return { mode: created[0].mode, revision: created[0].revision };
      }
      const [updated] = await transaction.query<[AutonomyRecord[]]>(
        `UPDATE governance_autonomy
         SET mode = $mode, revision += 1, updated_at = time::now()
         WHERE organization_id = $organization_id AND revision = $expected_revision
         RETURN AFTER;`,
        { organization_id: context.organizationId, mode: input.mode, expected_revision: input.expectedRevision },
      );
      if (!updated[0]) throw new Error("자율성 모드 revision이 일치하지 않습니다");
      return { mode: updated[0].mode, revision: updated[0].revision };
    });
  }
}
