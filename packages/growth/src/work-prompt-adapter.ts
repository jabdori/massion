import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import type { PromptVersionResolver, ResolveWorkPromptInput, ResolvedWorkPrompt } from "@massion/work";

import { canonicalGrowthJson, growthChecksum, type PromptMemoryStore } from "./prompt-memory.js";
import {
  GROWTH_ADOPTION_MIGRATION,
  GROWTH_EFFECT_REVERT_MIGRATION,
  GROWTH_PRODUCTION_EFFECT_LINEAGE_MIGRATION,
} from "./schema.js";

interface ChecksumRecord {
  readonly checksum: string;
}

export class GrowthWorkPromptAdapter implements PromptVersionResolver {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly prompts: PromptMemoryStore,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    prompts: PromptMemoryStore,
  ): Promise<GrowthWorkPromptAdapter> {
    await applyMigrations(database, [
      GROWTH_ADOPTION_MIGRATION,
      GROWTH_EFFECT_REVERT_MIGRATION,
      GROWTH_PRODUCTION_EFFECT_LINEAGE_MIGRATION,
    ]);
    return new GrowthWorkPromptAdapter(database, organizations, prompts);
  }

  public async resolve(
    context: TenantContext,
    input: ResolveWorkPromptInput,
    executor: QueryExecutor = this.database,
  ): Promise<ResolvedWorkPrompt> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    if (input.requesterUserId !== context.userId) {
      await this.organizations.verifyOrganizationMember(input.requesterUserId, context.organizationId, executor);
    }
    const organizationChecksum = await this.organizationChecksum(
      executor,
      context.organizationId,
      input.organizationVersionId,
    );
    const contextChecksum = input.contextVersionId
      ? await this.storedChecksum(
          executor,
          "context_version",
          "context_version_id",
          context.organizationId,
          input.contextVersionId,
        )
      : undefined;
    const policyChecksum = input.policyVersionId
      ? await this.storedChecksum(
          executor,
          "governance_policy_version",
          "policy_version_id",
          context.organizationId,
          input.policyVersionId,
        )
      : undefined;
    const composed = await this.prompts.compose(
      context,
      {
        workId: input.workId,
        requesterUserId: input.requesterUserId,
        organizationVersionId: input.organizationVersionId,
        organizationChecksum,
        ...(input.contextVersionId ? { contextVersionId: input.contextVersionId } : {}),
        ...(contextChecksum ? { contextChecksum } : {}),
        ...(input.policyVersionId ? { policyVersionId: input.policyVersionId } : {}),
        ...(policyChecksum ? { policyChecksum } : {}),
      },
      executor,
    );
    await this.assertNotSuspended(
      executor,
      context.organizationId,
      [
        composed.promptDefinitionVersionId,
        ...composed.memoryVersionIds,
        composed.policyVersionId,
        composed.organizationVersionId,
      ].filter((value): value is string => value !== undefined),
    );
    return { promptVersionId: composed.promptVersionId, schemaVersion: composed.schemaVersion };
  }

  public async verify(
    context: TenantContext,
    promptVersionId: string,
    executor: QueryExecutor = this.database,
  ): Promise<void> {
    await this.prompts.verifyPromptVersion(context, promptVersionId, executor);
  }

  private async organizationChecksum(
    executor: QueryExecutor,
    organizationId: string,
    versionId: string,
  ): Promise<string> {
    const [records] = await executor.query<[Array<Record<string, unknown>>]>(
      "SELECT * OMIT id FROM organization_version WHERE organization_id = $organization_id AND version_id = $version_id LIMIT 1;",
      { organization_id: organizationId, version_id: versionId },
    );
    const record = records[0];
    if (!record) throw new Error(`OrganizationVersion을 찾을 수 없습니다: ${versionId}`);
    return growthChecksum(JSON.parse(canonicalGrowthJson(record)));
  }

  private async storedChecksum(
    executor: QueryExecutor,
    table: "context_version" | "governance_policy_version",
    idField: "context_version_id" | "policy_version_id",
    organizationId: string,
    id: string,
  ): Promise<string> {
    const [records] = await executor.query<[ChecksumRecord[]]>(
      `SELECT checksum FROM ${table} WHERE organization_id = $organization_id AND ${idField} = $id LIMIT 1;`,
      { organization_id: organizationId, id },
    );
    if (!records[0]) throw new Error(`${idField} 참조를 찾을 수 없습니다: ${id}`);
    return records[0].checksum;
  }

  private async assertNotSuspended(
    executor: QueryExecutor,
    organizationId: string,
    versionIds: readonly string[],
  ): Promise<void> {
    const [records] = await executor.query<[Array<{ after_version_id: string }>]>(
      "SELECT after_version_id FROM growth_adoption_run WHERE organization_id = $organization_id AND exposure_status = 'suspended' AND after_version_id IN $version_ids LIMIT 1;",
      { organization_id: organizationId, version_ids: versionIds },
    );
    if (records[0]) throw new Error("중단된 Growth version은 새 Work에 사용할 수 없습니다");
  }
}
