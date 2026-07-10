import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type {
  CaptureRepositoryRevisionInput,
  CompleteIndexInput,
  CreateIndexConfigurationInput,
  EvidenceRepository,
  FailIndexInput,
  IndexConfiguration,
  IndexVersion,
  RegisterRepositoryInput,
  RepositoryAuditFinding,
  RepositoryRevision,
  StartIndexInput,
} from "./contracts.js";
import { EVIDENCE_CONTENT_MIGRATION, EVIDENCE_INDEX_MIGRATION } from "./schema.js";

interface RepositoryRecord {
  readonly repository_id: string;
  readonly organization_id: string;
  readonly project_id?: string;
  readonly name: string;
  readonly provider_kind: EvidenceRepository["providerKind"];
  readonly root_ref: string;
  readonly root_real_path_hash: string;
  readonly default_branch?: string;
  readonly status: EvidenceRepository["status"];
  readonly current_index_version_id?: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface RevisionRecord {
  readonly repository_revision_id: string;
  readonly organization_id: string;
  readonly repository_id: string;
  readonly version: number;
  readonly provider_revision: string;
  readonly revision: string;
  readonly dirty: boolean;
  readonly dirty_fingerprint?: string;
  readonly manifest_checksum: string;
  readonly root_real_path_hash: string;
  readonly collector_version: string;
  readonly captured_by_user_id: string;
  readonly captured_at: unknown;
}

interface ConfigurationRecord {
  readonly configuration_id: string;
  readonly organization_id: string;
  readonly repository_id: string;
  readonly version: number;
  readonly checksum: string;
  readonly parser_bundle_version: string;
  readonly schema_version: string;
  readonly embedding_version?: string;
  readonly embedding_status: IndexConfiguration["embeddingStatus"];
  readonly settings_json: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
}

interface IndexRecord {
  readonly index_version_id: string;
  readonly organization_id: string;
  readonly repository_id: string;
  readonly repository_revision_id: string;
  readonly configuration_id: string;
  readonly version: number;
  readonly mode: IndexVersion["mode"];
  readonly parent_index_version_id?: string;
  readonly status: IndexVersion["status"];
  readonly current: boolean;
  readonly parser_bundle_version: string;
  readonly schema_version: string;
  readonly embedding_version?: string;
  readonly embedding_status: IndexVersion["embeddingStatus"];
  readonly configuration_checksum: string;
  readonly dedupe_key?: string;
  readonly snapshot_checksum?: string;
  readonly file_count: number;
  readonly symbol_count: number;
  readonly relation_count: number;
  readonly chunk_count: number;
  readonly error_json?: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
  readonly completed_at?: unknown;
  readonly updated_at: unknown;
}

interface EventRecord {
  readonly command_id: string;
  readonly request_hash: string;
  readonly result_json: string;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertChecksum(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}은 SHA-256 형식이어야 합니다`);
}

export class RepositoryStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<RepositoryStore> {
    await applyMigrations(database, [EVIDENCE_INDEX_MIGRATION, EVIDENCE_CONTENT_MIGRATION]);
    return new RepositoryStore(database, organizations);
  }

  public async register(
    context: TenantContext,
    input: RegisterRepositoryInput,
  ): Promise<{ readonly repository: EvidenceRepository }> {
    await this.organizations.verifyTenantContext(context);
    if (!input.name.trim() || !input.rootRef.trim()) throw new Error("Repository name과 root reference가 필요합니다");
    assertChecksum(input.rootRealPathHash, "Repository root real path hash");
    const requestHash = hashRequest(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay<{ readonly repositoryId: string }>(
        tx,
        context.organizationId,
        input.commandId,
        requestHash,
        "repository",
      );
      if (repeated) {
        return {
          repository: this.repositoryView(await this.findRepository(tx, context.organizationId, repeated.repositoryId)),
        };
      }
      const [sameNames] = await tx.query<[RepositoryRecord[]]>(
        "SELECT * OMIT id FROM evidence_repository WHERE organization_id = $organization_id AND name = $name LIMIT 1;",
        { organization_id: context.organizationId, name: input.name.trim() },
      );
      if (sameNames[0]) throw new Error(`같은 이름의 Repository가 이미 있습니다: ${input.name.trim()}`);
      const [created] = await tx.query<[RepositoryRecord[]]>(
        "CREATE evidence_repository CONTENT { repository_id: $repository_id, organization_id: $organization_id, project_id: $project_id, name: $name, provider_kind: $provider_kind, root_ref: $root_ref, root_real_path_hash: $root_real_path_hash, default_branch: $default_branch, status: 'active', created_by_user_id: $created_by_user_id, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          repository_id: randomUUID(),
          organization_id: context.organizationId,
          project_id: input.projectId,
          name: input.name.trim(),
          provider_kind: input.providerKind,
          root_ref: input.rootRef.trim(),
          root_real_path_hash: input.rootRealPathHash,
          default_branch: input.defaultBranch?.trim(),
          created_by_user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("Repository 생성 결과가 없습니다");
      const result = { repository: this.repositoryView(created[0]) };
      await this.recordEvent(tx, context, {
        repositoryId: created[0].repository_id,
        commandId: input.commandId,
        eventType: "repository_registered",
        requestHash,
        payload: { providerKind: input.providerKind },
        result,
        replayResult: { repositoryId: created[0].repository_id },
      });
      return result;
    });
  }

  public async getRepository(context: TenantContext, repositoryId: string): Promise<EvidenceRepository> {
    await this.organizations.verifyTenantContext(context);
    return this.repositoryView(await this.findRepository(this.database, context.organizationId, repositoryId));
  }

  public async captureRevision(
    context: TenantContext,
    input: CaptureRepositoryRevisionInput,
  ): Promise<{ readonly revision: RepositoryRevision }> {
    await this.organizations.verifyTenantContext(context);
    if (!input.providerRevision.trim() || !input.collectorVersion.trim())
      throw new Error("Provider revision과 collector version이 필요합니다");
    if (input.dirty && !input.dirtyFingerprint) throw new Error("dirty revision에는 fingerprint가 필요합니다");
    if (!input.dirty && input.dirtyFingerprint)
      throw new Error("clean revision에는 dirty fingerprint를 쓸 수 없습니다");
    if (input.dirtyFingerprint) assertChecksum(input.dirtyFingerprint, "Dirty fingerprint");
    assertChecksum(input.manifestChecksum, "Revision manifest checksum");
    assertChecksum(input.rootRealPathHash, "Revision root real path hash");
    const requestHash = hashRequest(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay<{ readonly revision: RepositoryRevision }>(
        tx,
        context.organizationId,
        input.commandId,
        requestHash,
        "repository revision",
      );
      if (repeated) return repeated;
      const repository = await this.findRepository(tx, context.organizationId, input.repositoryId);
      if (repository.root_real_path_hash !== input.rootRealPathHash)
        throw new Error("Repository root real path hash가 등록 값과 다릅니다");
      const revision = input.dirty
        ? `${input.providerRevision.trim()}:dirty:${input.dirtyFingerprint ?? ""}`
        : input.providerRevision.trim();
      const existing = await this.findRevisionSnapshot(
        tx,
        context.organizationId,
        input.repositoryId,
        revision,
        input.manifestChecksum,
      );
      let record = existing;
      if (!record) {
        const revisions = await this.listRevisionRecords(tx, context.organizationId, input.repositoryId);
        const [created] = await tx.query<[RevisionRecord[]]>(
          "CREATE repository_revision CONTENT { repository_revision_id: $repository_revision_id, organization_id: $organization_id, repository_id: $repository_id, version: $version, provider_revision: $provider_revision, revision: $revision, dirty: $dirty, dirty_fingerprint: $dirty_fingerprint, manifest_checksum: $manifest_checksum, root_real_path_hash: $root_real_path_hash, collector_version: $collector_version, captured_by_user_id: $captured_by_user_id, captured_at: time::now() } RETURN AFTER;",
          {
            repository_revision_id: randomUUID(),
            organization_id: context.organizationId,
            repository_id: input.repositoryId,
            version: revisions.reduce((maximum, item) => Math.max(maximum, item.version), 0) + 1,
            provider_revision: input.providerRevision.trim(),
            revision,
            dirty: input.dirty,
            dirty_fingerprint: input.dirtyFingerprint,
            manifest_checksum: input.manifestChecksum,
            root_real_path_hash: input.rootRealPathHash,
            collector_version: input.collectorVersion.trim(),
            captured_by_user_id: context.userId,
          },
        );
        record = created[0];
      }
      if (!record) throw new Error("RepositoryRevision 생성 결과가 없습니다");
      const result = { revision: this.revisionView(record) };
      await this.recordEvent(tx, context, {
        repositoryId: input.repositoryId,
        repositoryRevisionId: record.repository_revision_id,
        commandId: input.commandId,
        eventType: "repository_revision_captured",
        requestHash,
        payload: { version: record.version, dirty: record.dirty, manifestChecksum: record.manifest_checksum },
        result,
      });
      return result;
    });
  }

  public async listRevisions(context: TenantContext, repositoryId: string): Promise<RepositoryRevision[]> {
    await this.getRepository(context, repositoryId);
    return (await this.listRevisionRecords(this.database, context.organizationId, repositoryId)).map((record) =>
      this.revisionView(record),
    );
  }

  public async getRevision(context: TenantContext, repositoryRevisionId: string): Promise<RepositoryRevision> {
    await this.organizations.verifyTenantContext(context);
    return this.revisionView(await this.findRevision(this.database, context.organizationId, repositoryRevisionId));
  }

  public async createConfiguration(
    context: TenantContext,
    input: CreateIndexConfigurationInput,
  ): Promise<{ readonly configuration: IndexConfiguration }> {
    await this.organizations.verifyTenantContext(context);
    assertChecksum(input.checksum, "Index configuration checksum");
    if (!input.parserBundleVersion.trim() || !input.schemaVersion.trim())
      throw new Error("Parser bundle과 schema version이 필요합니다");
    const requestHash = hashRequest(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay<{ readonly configuration: IndexConfiguration }>(
        tx,
        context.organizationId,
        input.commandId,
        requestHash,
        "index configuration",
      );
      if (repeated) return repeated;
      await this.findRepository(tx, context.organizationId, input.repositoryId);
      const [records] = await tx.query<[ConfigurationRecord[]]>(
        "SELECT * OMIT id FROM index_configuration WHERE organization_id = $organization_id AND repository_id = $repository_id ORDER BY version ASC;",
        { organization_id: context.organizationId, repository_id: input.repositoryId },
      );
      let record = records.find((item) => item.checksum === input.checksum);
      if (!record) {
        const [created] = await tx.query<[ConfigurationRecord[]]>(
          "CREATE index_configuration CONTENT { configuration_id: $configuration_id, organization_id: $organization_id, repository_id: $repository_id, version: $version, checksum: $checksum, parser_bundle_version: $parser_bundle_version, schema_version: $schema_version, embedding_version: $embedding_version, embedding_status: $embedding_status, settings_json: $settings_json, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
          {
            configuration_id: randomUUID(),
            organization_id: context.organizationId,
            repository_id: input.repositoryId,
            version: records.reduce((maximum, item) => Math.max(maximum, item.version), 0) + 1,
            checksum: input.checksum,
            parser_bundle_version: input.parserBundleVersion.trim(),
            schema_version: input.schemaVersion.trim(),
            embedding_version: input.embeddingVersion?.trim(),
            embedding_status: input.embeddingStatus,
            settings_json: canonicalJson(input.settings),
            created_by_user_id: context.userId,
          },
        );
        record = created[0];
      }
      if (!record) throw new Error("IndexConfiguration 생성 결과가 없습니다");
      const result = { configuration: this.configurationView(record) };
      await this.recordEvent(tx, context, {
        repositoryId: input.repositoryId,
        commandId: input.commandId,
        eventType: "index_configuration_created",
        requestHash,
        payload: { version: record.version, checksum: record.checksum },
        result,
      });
      return result;
    });
  }

  public async startIndex(context: TenantContext, input: StartIndexInput): Promise<{ readonly index: IndexVersion }> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = hashRequest(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay<{ readonly index: IndexVersion }>(
        tx,
        context.organizationId,
        input.commandId,
        requestHash,
        "index",
      );
      if (repeated) return repeated;
      await this.findRepository(tx, context.organizationId, input.repositoryId);
      const revision = await this.findRevision(tx, context.organizationId, input.repositoryRevisionId);
      const configuration = await this.findConfiguration(tx, context.organizationId, input.configurationId);
      if (revision.repository_id !== input.repositoryId || configuration.repository_id !== input.repositoryId)
        throw new Error("Index 입력의 Repository가 일치하지 않습니다");
      if (input.parentIndexVersionId) {
        const parent = await this.findIndex(tx, context.organizationId, input.parentIndexVersionId);
        if (parent.repository_id !== input.repositoryId || parent.status !== "complete" || !parent.current)
          throw new Error("parent IndexVersion은 같은 Repository의 current complete여야 합니다");
      }
      const records = await this.listIndexRecords(tx, context.organizationId, input.repositoryId);
      const dedupeKey =
        input.mode === "reconcile"
          ? undefined
          : hashRequest({
              organizationId: context.organizationId,
              repositoryId: input.repositoryId,
              repositoryRevisionId: input.repositoryRevisionId,
              configurationId: input.configurationId,
            });
      if (dedupeKey && records.some((record) => record.dedupe_key === dedupeKey))
        throw new Error("같은 revision과 configuration의 IndexVersion이 이미 있습니다");
      const [created] = await tx.query<[IndexRecord[]]>(
        "CREATE index_version CONTENT { index_version_id: $index_version_id, organization_id: $organization_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, configuration_id: $configuration_id, version: $version, mode: $mode, parent_index_version_id: $parent_index_version_id, status: 'building', current: false, parser_bundle_version: $parser_bundle_version, schema_version: $schema_version, embedding_version: $embedding_version, embedding_status: $embedding_status, configuration_checksum: $configuration_checksum, dedupe_key: $dedupe_key, file_count: 0, symbol_count: 0, relation_count: 0, chunk_count: 0, created_by_user_id: $created_by_user_id, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          index_version_id: randomUUID(),
          organization_id: context.organizationId,
          repository_id: input.repositoryId,
          repository_revision_id: input.repositoryRevisionId,
          configuration_id: input.configurationId,
          version: records.reduce((maximum, item) => Math.max(maximum, item.version), 0) + 1,
          mode: input.mode,
          parent_index_version_id: input.parentIndexVersionId,
          parser_bundle_version: configuration.parser_bundle_version,
          schema_version: configuration.schema_version,
          embedding_version: configuration.embedding_version,
          embedding_status: configuration.embedding_status,
          configuration_checksum: configuration.checksum,
          dedupe_key: dedupeKey,
          created_by_user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("IndexVersion 생성 결과가 없습니다");
      const result = { index: this.indexView(created[0]) };
      await this.recordEvent(tx, context, {
        repositoryId: input.repositoryId,
        repositoryRevisionId: input.repositoryRevisionId,
        indexVersionId: created[0].index_version_id,
        commandId: input.commandId,
        eventType: "index_started",
        requestHash,
        payload: { mode: input.mode, version: created[0].version },
        result,
      });
      return result;
    });
  }

  public async getConfiguration(context: TenantContext, configurationId: string): Promise<IndexConfiguration> {
    await this.organizations.verifyTenantContext(context);
    return this.configurationView(await this.findConfiguration(this.database, context.organizationId, configurationId));
  }

  public async completeIndex(
    context: TenantContext,
    input: CompleteIndexInput,
  ): Promise<{ readonly index: IndexVersion }> {
    await this.organizations.verifyTenantContext(context);
    assertChecksum(input.snapshotChecksum, "Index snapshot checksum");
    for (const [name, count] of Object.entries(input.counts)) {
      if (!Number.isInteger(count) || count < 0) throw new Error(`Index ${name} count는 0 이상의 정수여야 합니다`);
    }
    const requestHash = hashRequest(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay<{ readonly index: IndexVersion }>(
        tx,
        context.organizationId,
        input.commandId,
        requestHash,
        "index completion",
      );
      if (repeated) return repeated;
      const target = await this.findIndex(tx, context.organizationId, input.indexVersionId);
      if (target.status !== "building") throw new Error(`building IndexVersion만 완료할 수 있습니다: ${target.status}`);
      const records = await this.listIndexRecords(tx, context.organizationId, target.repository_id);
      for (const current of records.filter((item) => item.current)) {
        if (current.status !== "complete") throw new Error("current IndexVersion이 complete 상태가 아닙니다");
        await tx.query(
          "UPDATE index_version SET status = 'superseded', current = false, updated_at = time::now() WHERE organization_id = $organization_id AND index_version_id = $index_version_id;",
          { organization_id: context.organizationId, index_version_id: current.index_version_id },
        );
      }
      const [updated] = await tx.query<[IndexRecord[]]>(
        "UPDATE index_version SET status = 'complete', current = true, snapshot_checksum = $snapshot_checksum, file_count = $file_count, symbol_count = $symbol_count, relation_count = $relation_count, chunk_count = $chunk_count, completed_at = time::now(), updated_at = time::now() WHERE organization_id = $organization_id AND index_version_id = $index_version_id AND status = 'building' RETURN AFTER;",
        {
          snapshot_checksum: input.snapshotChecksum,
          file_count: input.counts.files,
          symbol_count: input.counts.symbols,
          relation_count: input.counts.relations,
          chunk_count: input.counts.chunks,
          organization_id: context.organizationId,
          index_version_id: target.index_version_id,
        },
      );
      if (!updated[0]) throw new Error("IndexVersion complete 전이에 실패했습니다");
      await tx.query(
        "UPDATE evidence_repository SET current_index_version_id = $index_version_id, updated_at = time::now() WHERE organization_id = $organization_id AND repository_id = $repository_id;",
        {
          index_version_id: target.index_version_id,
          organization_id: context.organizationId,
          repository_id: target.repository_id,
        },
      );
      const result = { index: this.indexView(updated[0]) };
      await this.recordEvent(tx, context, {
        repositoryId: target.repository_id,
        repositoryRevisionId: target.repository_revision_id,
        indexVersionId: target.index_version_id,
        commandId: input.commandId,
        eventType: target.mode === "reconcile" ? "index_reconciled" : "index_completed",
        requestHash,
        payload: { version: target.version, counts: input.counts, snapshotChecksum: input.snapshotChecksum },
        result,
      });
      return result;
    });
  }

  public async getCurrentIndex(context: TenantContext, repositoryId: string): Promise<IndexVersion | undefined> {
    const repository = await this.getRepository(context, repositoryId);
    if (!repository.currentIndexVersionId) return undefined;
    return this.indexView(
      await this.findIndex(this.database, context.organizationId, repository.currentIndexVersionId),
    );
  }

  public async getIndex(context: TenantContext, indexVersionId: string): Promise<IndexVersion> {
    await this.organizations.verifyTenantContext(context);
    return this.indexView(await this.findIndex(this.database, context.organizationId, indexVersionId));
  }

  public async failIndex(context: TenantContext, input: FailIndexInput): Promise<{ readonly index: IndexVersion }> {
    await this.organizations.verifyTenantContext(context);
    if (!input.error.category.trim() || !/^[a-f0-9]{64}$/u.test(input.error.causeId))
      throw new Error("Index failure category와 SHA-256 cause ID가 필요합니다");
    const requestHash = hashRequest(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay<{ readonly index: IndexVersion }>(
        tx,
        context.organizationId,
        input.commandId,
        requestHash,
        "index failure",
      );
      if (repeated) return repeated;
      const target = await this.findIndex(tx, context.organizationId, input.indexVersionId);
      if (target.status !== "building")
        throw new Error(`building IndexVersion만 실패 전이할 수 있습니다: ${target.status}`);
      const [updated] = await tx.query<[IndexRecord[]]>(
        "UPDATE index_version SET status = $status, current = false, dedupe_key = NONE, error_json = $error_json, updated_at = time::now() WHERE organization_id = $organization_id AND index_version_id = $index_version_id AND status = 'building' RETURN AFTER;",
        {
          status: input.status,
          error_json: canonicalJson(input.error),
          organization_id: context.organizationId,
          index_version_id: input.indexVersionId,
        },
      );
      if (!updated[0]) throw new Error("IndexVersion failure 전이에 실패했습니다");
      const result = { index: this.indexView(updated[0]) };
      await this.recordEvent(tx, context, {
        repositoryId: target.repository_id,
        repositoryRevisionId: target.repository_revision_id,
        indexVersionId: target.index_version_id,
        commandId: input.commandId,
        eventType: `index_${input.status}`,
        requestHash,
        payload: { status: input.status, error: input.error },
        result,
      });
      return result;
    });
  }

  public async listIndexes(context: TenantContext, repositoryId: string): Promise<IndexVersion[]> {
    await this.getRepository(context, repositoryId);
    return (await this.listIndexRecords(this.database, context.organizationId, repositoryId)).map((record) =>
      this.indexView(record),
    );
  }

  public async recordFreshnessAssessment(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly evidenceBriefId: string;
      readonly repositoryId: string;
      readonly indexVersionId: string;
      readonly status: "stale_warning" | "reindex_required" | "blocked";
      readonly reasons: readonly string[];
    },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = hashRequest(input);
    await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay<{ readonly recorded: true }>(
        tx,
        context.organizationId,
        input.commandId,
        requestHash,
        "evidence freshness",
      );
      if (repeated) return;
      await this.findRepository(tx, context.organizationId, input.repositoryId);
      const index = await this.findIndex(tx, context.organizationId, input.indexVersionId);
      if (index.repository_id !== input.repositoryId)
        throw new Error("Evidence freshness IndexVersion과 Repository가 일치하지 않습니다");
      await this.recordEvent(tx, context, {
        repositoryId: input.repositoryId,
        repositoryRevisionId: index.repository_revision_id,
        indexVersionId: input.indexVersionId,
        commandId: input.commandId,
        eventType: "evidence_stale_detected",
        requestHash,
        payload: {
          evidenceBriefId: input.evidenceBriefId,
          status: input.status,
          reasons: [...input.reasons].sort(),
        },
        result: { recorded: true },
      });
    });
  }

  public async audit(context: TenantContext, repositoryId: string): Promise<RepositoryAuditFinding[]> {
    const repository = await this.getRepository(context, repositoryId);
    const indexes = await this.listIndexes(context, repositoryId);
    const findings: RepositoryAuditFinding[] = [];
    const currents = indexes.filter((index) => index.current);
    if (currents.length > 1 || currents.some((index) => index.status !== "complete")) {
      findings.push({
        code: "current-index",
        message: "current complete IndexVersion 수가 1보다 많거나 상태가 잘못됐습니다",
      });
    }
    if (indexes.some((index, position) => index.version !== position + 1)) {
      findings.push({ code: "index-version", message: "IndexVersion version이 연속적이지 않습니다" });
    }
    if (repository.currentIndexVersionId !== currents[0]?.indexVersionId) {
      findings.push({ code: "repository-pointer", message: "Repository current pointer와 IndexVersion이 다릅니다" });
    }
    return findings;
  }

  private async replay<Result>(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
    requestHash: string,
    kind: string,
  ): Promise<Result | undefined> {
    const [events] = await executor.query<[EventRecord[]]>(
      "SELECT command_id, request_hash, result_json FROM evidence_index_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (!events[0]) return undefined;
    if (events[0].request_hash !== requestHash)
      throw new Error(`같은 commandId에 다른 ${kind} 명령을 사용할 수 없습니다`);
    return JSON.parse(events[0].result_json) as Result;
  }

  private async recordEvent(
    executor: QueryExecutor,
    context: TenantContext,
    input: {
      readonly repositoryId: string;
      readonly repositoryRevisionId?: string;
      readonly indexVersionId?: string;
      readonly commandId: string;
      readonly eventType: string;
      readonly requestHash: string;
      readonly payload: unknown;
      readonly result: unknown;
      readonly replayResult?: unknown;
    },
  ): Promise<void> {
    await executor.query(
      "CREATE evidence_index_event CONTENT { event_id: $event_id, organization_id: $organization_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, index_version_id: $index_version_id, command_id: $command_id, event_type: $event_type, request_hash: $request_hash, payload_json: $payload_json, result_json: $result_json, actor_user_id: $actor_user_id, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        repository_id: input.repositoryId,
        repository_revision_id: input.repositoryRevisionId,
        index_version_id: input.indexVersionId,
        command_id: input.commandId,
        event_type: input.eventType,
        request_hash: input.requestHash,
        payload_json: canonicalJson(input.payload),
        result_json: JSON.stringify(input.replayResult ?? input.result),
        actor_user_id: context.userId,
      },
    );
  }

  private async findRepository(
    executor: QueryExecutor,
    organizationId: string,
    repositoryId: string,
  ): Promise<RepositoryRecord> {
    const [records] = await executor.query<[RepositoryRecord[]]>(
      "SELECT * OMIT id FROM evidence_repository WHERE organization_id = $organization_id AND repository_id = $repository_id LIMIT 1;",
      { organization_id: organizationId, repository_id: repositoryId },
    );
    if (!records[0]) throw new Error(`Repository를 찾을 수 없습니다: ${repositoryId}`);
    return records[0];
  }

  private async listRevisionRecords(
    executor: QueryExecutor,
    organizationId: string,
    repositoryId: string,
  ): Promise<RevisionRecord[]> {
    const [records] = await executor.query<[RevisionRecord[]]>(
      "SELECT * OMIT id FROM repository_revision WHERE organization_id = $organization_id AND repository_id = $repository_id ORDER BY version ASC;",
      { organization_id: organizationId, repository_id: repositoryId },
    );
    return records;
  }

  private async findRevisionSnapshot(
    executor: QueryExecutor,
    organizationId: string,
    repositoryId: string,
    revision: string,
    manifestChecksum: string,
  ): Promise<RevisionRecord | undefined> {
    const records = await this.listRevisionRecords(executor, organizationId, repositoryId);
    return records.find((item) => item.revision === revision && item.manifest_checksum === manifestChecksum);
  }

  private async findRevision(
    executor: QueryExecutor,
    organizationId: string,
    repositoryRevisionId: string,
  ): Promise<RevisionRecord> {
    const [records] = await executor.query<[RevisionRecord[]]>(
      "SELECT * OMIT id FROM repository_revision WHERE organization_id = $organization_id AND repository_revision_id = $repository_revision_id LIMIT 1;",
      { organization_id: organizationId, repository_revision_id: repositoryRevisionId },
    );
    if (!records[0]) throw new Error(`RepositoryRevision을 찾을 수 없습니다: ${repositoryRevisionId}`);
    return records[0];
  }

  private async findConfiguration(
    executor: QueryExecutor,
    organizationId: string,
    configurationId: string,
  ): Promise<ConfigurationRecord> {
    const [records] = await executor.query<[ConfigurationRecord[]]>(
      "SELECT * OMIT id FROM index_configuration WHERE organization_id = $organization_id AND configuration_id = $configuration_id LIMIT 1;",
      { organization_id: organizationId, configuration_id: configurationId },
    );
    if (!records[0]) throw new Error(`IndexConfiguration을 찾을 수 없습니다: ${configurationId}`);
    return records[0];
  }

  private async findIndex(
    executor: QueryExecutor,
    organizationId: string,
    indexVersionId: string,
  ): Promise<IndexRecord> {
    const [records] = await executor.query<[IndexRecord[]]>(
      "SELECT * OMIT id FROM index_version WHERE organization_id = $organization_id AND index_version_id = $index_version_id LIMIT 1;",
      { organization_id: organizationId, index_version_id: indexVersionId },
    );
    if (!records[0]) throw new Error(`IndexVersion을 찾을 수 없습니다: ${indexVersionId}`);
    return records[0];
  }

  private async listIndexRecords(
    executor: QueryExecutor,
    organizationId: string,
    repositoryId: string,
  ): Promise<IndexRecord[]> {
    const [records] = await executor.query<[IndexRecord[]]>(
      "SELECT * OMIT id FROM index_version WHERE organization_id = $organization_id AND repository_id = $repository_id ORDER BY version ASC;",
      { organization_id: organizationId, repository_id: repositoryId },
    );
    return records;
  }

  private repositoryView(record: RepositoryRecord): EvidenceRepository {
    return {
      repositoryId: record.repository_id,
      organizationId: record.organization_id,
      ...(record.project_id ? { projectId: record.project_id } : {}),
      name: record.name,
      providerKind: record.provider_kind,
      rootRef: record.root_ref,
      rootRealPathHash: record.root_real_path_hash,
      ...(record.default_branch ? { defaultBranch: record.default_branch } : {}),
      status: record.status,
      ...(record.current_index_version_id ? { currentIndexVersionId: record.current_index_version_id } : {}),
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }

  private revisionView(record: RevisionRecord): RepositoryRevision {
    return {
      repositoryRevisionId: record.repository_revision_id,
      organizationId: record.organization_id,
      repositoryId: record.repository_id,
      version: record.version,
      providerRevision: record.provider_revision,
      revision: record.revision,
      dirty: record.dirty,
      ...(record.dirty_fingerprint ? { dirtyFingerprint: record.dirty_fingerprint } : {}),
      manifestChecksum: record.manifest_checksum,
      rootRealPathHash: record.root_real_path_hash,
      collectorVersion: record.collector_version,
      capturedByUserId: record.captured_by_user_id,
      capturedAt: record.captured_at,
    };
  }

  private configurationView(record: ConfigurationRecord): IndexConfiguration {
    return {
      configurationId: record.configuration_id,
      organizationId: record.organization_id,
      repositoryId: record.repository_id,
      version: record.version,
      checksum: record.checksum,
      parserBundleVersion: record.parser_bundle_version,
      schemaVersion: record.schema_version,
      ...(record.embedding_version ? { embeddingVersion: record.embedding_version } : {}),
      embeddingStatus: record.embedding_status,
      settings: JSON.parse(record.settings_json) as unknown,
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
    };
  }

  private indexView(record: IndexRecord): IndexVersion {
    return {
      indexVersionId: record.index_version_id,
      organizationId: record.organization_id,
      repositoryId: record.repository_id,
      repositoryRevisionId: record.repository_revision_id,
      configurationId: record.configuration_id,
      version: record.version,
      mode: record.mode,
      ...(record.parent_index_version_id ? { parentIndexVersionId: record.parent_index_version_id } : {}),
      status: record.status,
      current: record.current,
      parserBundleVersion: record.parser_bundle_version,
      schemaVersion: record.schema_version,
      ...(record.embedding_version ? { embeddingVersion: record.embedding_version } : {}),
      embeddingStatus: record.embedding_status,
      configurationChecksum: record.configuration_checksum,
      ...(record.snapshot_checksum ? { snapshotChecksum: record.snapshot_checksum } : {}),
      fileCount: record.file_count,
      symbolCount: record.symbol_count,
      relationCount: record.relation_count,
      chunkCount: record.chunk_count,
      ...(record.error_json
        ? { error: JSON.parse(record.error_json) as { readonly category: string; readonly causeId: string } }
        : {}),
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
      ...(record.completed_at ? { completedAt: record.completed_at } : {}),
      updatedAt: record.updated_at,
    };
  }
}
