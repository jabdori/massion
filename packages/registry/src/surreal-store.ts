import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  assessmentPassed,
  assertDigest,
  assertRegistryId,
  normalizePackageIdentity,
  transitionVersion,
  type RegistryAssessment,
  type RegistryRecall,
  type RegistryVersion,
  type RegistryVersionInput,
} from "./contracts.js";
import { REGISTRY_MIGRATIONS } from "./schema.js";

interface VersionRecord {
  version_id: string;
  package_name: string;
  package_version: string;
  artifact_digest: string;
  content_digest: string;
  visibility: "public" | "private";
  owner_organization_id: string;
  manifest_json: string;
  state: "staged" | "published" | "recalled";
  assessment_json?: string;
  published_by_decision_id?: string;
  command_id: string;
  request_hash: string;
  created_at: string | Date;
  published_at?: string | Date;
}

interface RecallRecord {
  recall_id: string;
  category: RegistryRecall["category"];
  severity: RegistryRecall["severity"];
  reason: string;
  created_at: string | Date;
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

async function first<T>(executor: QueryExecutor, query: string, bindings: Record<string, unknown>): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

export class SurrealRegistryStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<SurrealRegistryStore> {
    await applyMigrations(database, REGISTRY_MIGRATIONS);
    return new SurrealRegistryStore(database, organizations);
  }

  public async stage(context: TenantContext, commandId: string, input: RegistryVersionInput): Promise<RegistryVersion> {
    await this.organizations.verifyTenantContext(context);
    if (input.ownerOrganizationId !== context.organizationId) throw new Error("다른 tenant의 package를 stage할 수 없습니다");
    assertRegistryId(commandId, "commandId");
    normalizePackageIdentity(input.packageName, input.packageVersion);
    assertDigest(input.artifactDigest, "artifact");
    assertDigest(input.contentDigest, "content");
    const requestHash = hash(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const replay = await first<VersionRecord>(
        tx,
        "SELECT * OMIT id FROM registry_version WHERE owner_organization_id=$organization_id AND command_id=$command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: commandId },
      );
      if (replay) {
        if (replay.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 Registry 요청을 사용할 수 없습니다");
        return this.view(replay);
      }
      const conflict = await first<VersionRecord>(
        tx,
        "SELECT * OMIT id FROM registry_version WHERE package_name=$package_name AND package_version=$package_version LIMIT 1;",
        { package_name: input.packageName, package_version: input.packageVersion },
      );
      if (conflict) {
        if (conflict.artifact_digest !== input.artifactDigest)
          throw new Error("같은 package version에 다른 artifact digest를 게시할 수 없습니다");
        throw new Error("같은 package version은 다른 command로 다시 stage할 수 없습니다");
      }
      const record = await first<VersionRecord>(
        tx,
        "CREATE registry_version CONTENT { version_id:$version_id, package_name:$package_name, package_version:$package_version, artifact_digest:$artifact_digest, content_digest:$content_digest, visibility:$visibility, owner_organization_id:$owner_organization_id, manifest_json:$manifest_json, state:'staged', assessment_json:NONE, published_by_decision_id:NONE, command_id:$command_id, request_hash:$request_hash, created_at:time::now(), published_at:NONE } RETURN AFTER;",
        {
          version_id: randomUUID(),
          package_name: input.packageName,
          package_version: input.packageVersion,
          artifact_digest: input.artifactDigest,
          content_digest: input.contentDigest,
          visibility: input.visibility,
          owner_organization_id: context.organizationId,
          manifest_json: canonical(input.manifest),
          command_id: commandId,
          request_hash: requestHash,
        },
      );
      if (!record) throw new Error("Registry version 생성 결과가 없습니다");
      return this.view(record);
    });
  }

  public async recordAssessment(context: TenantContext, versionId: string, assessment: RegistryAssessment): Promise<RegistryVersion> {
    const current = await this.getOwned(context, versionId);
    if (current.state !== "staged") throw new Error("staged version만 검사 결과를 기록할 수 있습니다");
    const record = await first<VersionRecord>(
      this.database,
      "UPDATE registry_version SET assessment_json=$assessment_json WHERE version_id=$version_id RETURN AFTER;",
      { version_id: versionId, assessment_json: canonical(assessment) },
    );
    if (!record) throw new Error("Registry assessment 기록 결과가 없습니다");
    return this.view(record);
  }

  public async publish(context: TenantContext, versionId: string, decisionId: string): Promise<RegistryVersion> {
    assertRegistryId(decisionId, "decision");
    const current = await this.getOwned(context, versionId);
    if (!assessmentPassed(current.assessment)) throw new Error("모든 Registry 검사가 통과해야 공개할 수 있습니다");
    transitionVersion(current.state, "published");
    const record = await first<VersionRecord>(
      this.database,
      "UPDATE registry_version SET state='published', published_by_decision_id=$decision_id, published_at=time::now() WHERE version_id=$version_id AND state='staged' RETURN AFTER;",
      { version_id: versionId, decision_id: decisionId },
    );
    if (!record) throw new Error("Registry publish 상태가 변경됐습니다");
    return this.view(record);
  }

  public async recall(context: TenantContext, versionId: string, recall: RegistryRecall): Promise<RegistryVersion> {
    assertRegistryId(recall.recallId, "recall");
    const current = await this.getOwned(context, versionId);
    transitionVersion(current.state, "recalled");
    return await this.database.transaction(async (tx) => {
      const existing = await first<RecallRecord>(tx, "SELECT * OMIT id FROM registry_recall WHERE recall_id=$recall_id LIMIT 1;", {
        recall_id: recall.recallId,
      });
      if (existing) throw new Error("recall 사건이 이미 존재합니다");
      await tx.query(
        "CREATE registry_recall CONTENT { recall_id:$recall_id, version_id:$version_id, package_name:$package_name, package_version:$package_version, category:$category, severity:$severity, reason:$reason, created_by_organization_id:$organization_id, created_at:time::now() };",
        {
          recall_id: recall.recallId,
          version_id: versionId,
          package_name: current.packageName,
          package_version: current.packageVersion,
          category: recall.category,
          severity: recall.severity,
          reason: recall.reason,
          organization_id: context.organizationId,
        },
      );
      const record = await first<VersionRecord>(
        tx,
        "UPDATE registry_version SET state='recalled' WHERE version_id=$version_id AND state='published' RETURN AFTER;",
        { version_id: versionId },
      );
      if (!record) throw new Error("Registry recall 상태가 변경됐습니다");
      return this.view(record);
    });
  }

  public async get(context: TenantContext, versionId: string): Promise<RegistryVersion> {
    await this.organizations.verifyTenantContext(context);
    const record = await first<VersionRecord>(
      this.database,
      "SELECT * OMIT id FROM registry_version WHERE version_id=$version_id AND (visibility='public' OR owner_organization_id=$organization_id) LIMIT 1;",
      { version_id: versionId, organization_id: context.organizationId },
    );
    if (!record) throw new Error("Registry version을 찾을 수 없습니다");
    return this.view(record);
  }

  public async listRecalls(context: TenantContext, versionId: string): Promise<readonly RegistryRecall[]> {
    await this.get(context, versionId);
    const [records] = await this.database.query<[RecallRecord[]]>(
      "SELECT * OMIT id FROM registry_recall WHERE version_id=$version_id ORDER BY created_at;",
      { version_id: versionId },
    );
    return records.map((record) => ({
      recallId: record.recall_id,
      category: record.category,
      severity: record.severity,
      reason: record.reason,
      createdAt: new Date(record.created_at).toISOString(),
    }));
  }

  private async getOwned(context: TenantContext, versionId: string): Promise<RegistryVersion> {
    await this.organizations.verifyTenantContext(context);
    const record = await first<VersionRecord>(
      this.database,
      "SELECT * OMIT id FROM registry_version WHERE version_id=$version_id AND owner_organization_id=$organization_id LIMIT 1;",
      { version_id: versionId, organization_id: context.organizationId },
    );
    if (!record) throw new Error("소유한 Registry version을 찾을 수 없습니다");
    return this.view(record);
  }

  private view(record: VersionRecord): RegistryVersion {
    return {
      versionId: record.version_id,
      packageName: record.package_name,
      packageVersion: record.package_version,
      artifactDigest: record.artifact_digest,
      contentDigest: record.content_digest,
      visibility: record.visibility,
      ownerOrganizationId: record.owner_organization_id,
      manifest: JSON.parse(record.manifest_json) as Record<string, unknown>,
      state: record.state,
      ...(record.assessment_json ? { assessment: JSON.parse(record.assessment_json) as RegistryAssessment } : {}),
      ...(record.published_by_decision_id ? { publishedByDecisionId: record.published_by_decision_id } : {}),
      createdAt: new Date(record.created_at).toISOString(),
      ...(record.published_at ? { publishedAt: new Date(record.published_at).toISOString() } : {}),
    };
  }
}
