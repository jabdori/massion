import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import type { OrganizationNode } from "@massion/organization";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { GROWTH_PROMPT_MEMORY_MIGRATION } from "./schema.js";

export interface PromptAgentSection {
  readonly agentHandle: string;
  readonly instruction: string;
  readonly capabilityReferences: readonly string[];
}

export interface PromptDefinitionVersion {
  readonly promptDefinitionVersionId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly parentVersionId?: string;
  readonly status: "active" | "superseded";
  readonly sections: readonly PromptAgentSection[];
  readonly checksum: string;
}

export interface MemoryEntry {
  readonly kind: "fact" | "preference" | "procedure";
  readonly key: string;
  readonly value: string;
  readonly sourceReferenceIds: readonly string[];
}

export interface MemoryVersion {
  readonly memoryVersionId: string;
  readonly organizationId: string;
  readonly scope: "organization" | "user" | "agent";
  readonly subjectId: string;
  readonly version: number;
  readonly parentVersionId?: string;
  readonly status: "active" | "superseded";
  readonly entries: readonly MemoryEntry[];
  readonly checksum: string;
}

export interface EffectivePromptVersion {
  readonly promptVersionId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly requesterUserId: string;
  readonly schemaVersion: "massion.work.prompt.v1";
  readonly composerVersion: "massion.prompt-composer.v1";
  readonly promptDefinitionVersionId: string;
  readonly promptDefinitionChecksum: string;
  readonly organizationVersionId: string;
  readonly organizationChecksum: string;
  readonly contextVersionId?: string;
  readonly contextChecksum?: string;
  readonly policyVersionId?: string;
  readonly policyChecksum?: string;
  readonly memoryVersionIds: readonly string[];
  readonly memoryChecksums: readonly string[];
  readonly sections: readonly PromptAgentSection[];
  readonly checksum: string;
}

interface DefinitionRecord {
  readonly prompt_definition_version_id: string;
  readonly organization_id: string;
  readonly version: number;
  readonly parent_version_id?: string;
  readonly status: "active" | "superseded";
  readonly sections_json: string;
  readonly checksum: string;
  readonly request_hash: string;
}

interface MemoryRecord {
  readonly memory_version_id: string;
  readonly organization_id: string;
  readonly scope: "organization" | "user" | "agent";
  readonly subject_id: string;
  readonly version: number;
  readonly parent_version_id?: string;
  readonly status: "active" | "superseded";
  readonly entries_json: string;
  readonly checksum: string;
  readonly request_hash: string;
}

interface PromptRecord {
  readonly prompt_version_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly requester_user_id: string;
  readonly schema_version: "massion.work.prompt.v1";
  readonly composer_version: "massion.prompt-composer.v1";
  readonly prompt_definition_version_id: string;
  readonly prompt_definition_checksum: string;
  readonly organization_version_id: string;
  readonly organization_checksum: string;
  readonly context_version_id?: string;
  readonly context_checksum?: string;
  readonly policy_version_id?: string;
  readonly policy_checksum?: string;
  readonly memory_version_ids: readonly string[];
  readonly memory_checksums: readonly string[];
  readonly agent_sections_json: string;
  readonly checksum: string;
}

export interface ComposeEffectivePromptInput {
  readonly workId: string;
  readonly requesterUserId: string;
  readonly organizationVersionId: string;
  readonly organizationChecksum: string;
  readonly contextVersionId?: string;
  readonly contextChecksum?: string;
  readonly policyVersionId?: string;
  readonly policyChecksum?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalGrowthJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function growthChecksum(value: unknown): string {
  return createHash("sha256").update(canonicalGrowthJson(value)).digest("hex");
}

function definition(record: DefinitionRecord): PromptDefinitionVersion {
  return {
    promptDefinitionVersionId: record.prompt_definition_version_id,
    organizationId: record.organization_id,
    version: record.version,
    ...(record.parent_version_id ? { parentVersionId: record.parent_version_id } : {}),
    status: record.status,
    sections: JSON.parse(record.sections_json) as PromptAgentSection[],
    checksum: record.checksum,
  };
}

function definitionContent(record: DefinitionRecord): unknown {
  return {
    id: record.prompt_definition_version_id,
    organizationId: record.organization_id,
    version: record.version,
    parentVersionId: record.parent_version_id,
    sections: JSON.parse(record.sections_json) as PromptAgentSection[],
  };
}

function checkedDefinition(record: DefinitionRecord): PromptDefinitionVersion {
  if (growthChecksum(definitionContent(record)) !== record.checksum) {
    throw new Error("PromptDefinitionVersion checksum이 일치하지 않습니다");
  }
  return definition(record);
}

function memory(record: MemoryRecord): MemoryVersion {
  return {
    memoryVersionId: record.memory_version_id,
    organizationId: record.organization_id,
    scope: record.scope,
    subjectId: record.subject_id,
    version: record.version,
    ...(record.parent_version_id ? { parentVersionId: record.parent_version_id } : {}),
    status: record.status,
    entries: JSON.parse(record.entries_json) as MemoryEntry[],
    checksum: record.checksum,
  };
}

function memoryContent(record: MemoryRecord): unknown {
  return {
    id: record.memory_version_id,
    organizationId: record.organization_id,
    scope: record.scope,
    subjectId: record.subject_id,
    version: record.version,
    parentVersionId: record.parent_version_id,
    entries: JSON.parse(record.entries_json) as MemoryEntry[],
  };
}

function checkedMemory(record: MemoryRecord): MemoryVersion {
  if (growthChecksum(memoryContent(record)) !== record.checksum) {
    throw new Error("MemoryVersion checksum이 일치하지 않습니다");
  }
  return memory(record);
}

function promptContent(record: Omit<PromptRecord, "checksum">): unknown {
  return {
    promptVersionId: record.prompt_version_id,
    organizationId: record.organization_id,
    workId: record.work_id,
    requesterUserId: record.requester_user_id,
    schemaVersion: record.schema_version,
    composerVersion: record.composer_version,
    promptDefinitionVersionId: record.prompt_definition_version_id,
    promptDefinitionChecksum: record.prompt_definition_checksum,
    organizationVersionId: record.organization_version_id,
    organizationChecksum: record.organization_checksum,
    contextVersionId: record.context_version_id,
    contextChecksum: record.context_checksum,
    policyVersionId: record.policy_version_id,
    policyChecksum: record.policy_checksum,
    memoryVersionIds: record.memory_version_ids,
    memoryChecksums: record.memory_checksums,
    sections: JSON.parse(record.agent_sections_json) as PromptAgentSection[],
  };
}

function prompt(record: PromptRecord): EffectivePromptVersion {
  const content = promptContent(record) as Omit<EffectivePromptVersion, "checksum">;
  return { ...content, checksum: record.checksum };
}

function validateSections(sections: readonly PromptAgentSection[]): void {
  if (sections.length === 0 || sections.length > 200) throw new Error("Prompt section은 1~200개여야 합니다");
  const handles = new Set<string>();
  for (const section of sections) {
    if (!section.agentHandle.trim() || handles.has(section.agentHandle))
      throw new Error("Prompt Agent handle이 비었거나 중복됐습니다");
    if (!section.instruction.trim() || section.instruction.length > 20_000)
      throw new Error("Prompt instruction은 1~20000자여야 합니다");
    handles.add(section.agentHandle);
  }
}

function validateEntries(entries: readonly MemoryEntry[]): void {
  if (entries.length > 500) throw new Error("Memory entry는 500개 이하여야 합니다");
  for (const entry of entries) {
    if (!entry.key.trim() || !entry.value.trim() || entry.value.length > 10_000)
      throw new Error("Memory entry key와 bounded value가 필요합니다");
    if (entry.sourceReferenceIds.length === 0 || entry.sourceReferenceIds.length > 100)
      throw new Error("Memory source reference는 1~100개여야 합니다");
  }
}

export class PromptMemoryStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<PromptMemoryStore> {
    await applyMigrations(database, [GROWTH_PROMPT_MEMORY_MIGRATION]);
    return new PromptMemoryStore(database, organizations);
  }

  public async bootstrap(context: TenantContext, nodes: readonly OrganizationNode[]): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    if (nodes.some((node) => node.organization_id !== context.organizationId))
      throw new Error("다른 tenant의 Organization node입니다");
    const sections = nodes
      .filter((node) => node.status === "active")
      .sort((left, right) => left.handle.localeCompare(right.handle))
      .map((node) => ({
        agentHandle: node.handle,
        instruction: `${node.responsibility}\n주요 산출물: ${node.outputs.join(", ")}`,
        capabilityReferences: [...node.capabilities].sort(),
      }));
    validateSections(sections);
    await this.database.transaction(async (executor) => {
      if (!(await this.activeDefinition(executor, context.organizationId))) {
        const commandId = "bootstrap-prompt-definition";
        await this.createDefinition(
          executor,
          context,
          commandId,
          growthChecksum({ commandId, expectedVersion: 0, sections }),
          sections,
          undefined,
        );
      }
      if (!(await this.activeMemory(executor, context.organizationId, "organization"))) {
        const commandId = "bootstrap-memory";
        await this.createMemory(
          executor,
          context,
          commandId,
          growthChecksum({ commandId, scope: "organization", expectedVersion: 0, entries: [] }),
          "organization",
          "organization",
          [],
          undefined,
        );
      }
    });
  }

  public async getActivePromptDefinition(context: TenantContext): Promise<PromptDefinitionVersion> {
    await this.organizations.verifyTenantContext(context);
    const record = await this.activeDefinition(this.database, context.organizationId);
    if (!record) throw new Error("활성 PromptDefinitionVersion을 찾을 수 없습니다");
    return checkedDefinition(record);
  }

  public async getActiveMemories(context: TenantContext, requesterUserId?: string): Promise<MemoryVersion[]> {
    await this.organizations.verifyTenantContext(context);
    const records: MemoryRecord[] = [];
    const organization = await this.activeMemory(this.database, context.organizationId, "organization");
    if (organization) records.push(organization);
    if (requesterUserId) {
      const [memberships] = await this.database.query<[unknown[]]>(
        "SELECT membership_id FROM membership WHERE organization_id = $organization_id AND user_id = $user_id AND status = 'active' LIMIT 1;",
        { organization_id: context.organizationId, user_id: requesterUserId },
      );
      if (memberships[0]) {
        const user = await this.activeMemory(this.database, context.organizationId, `user:${requesterUserId}`);
        if (user) records.push(user);
      }
    }
    return records.map(checkedMemory);
  }

  public async activatePromptDefinition(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly expectedVersion: number;
      readonly sections: readonly PromptAgentSection[];
    },
  ): Promise<PromptDefinitionVersion> {
    validateSections(input.sections);
    const requestHash = growthChecksum(input);
    return await this.database.transaction(async (executor) => {
      await this.organizations.verifyTenantContext(context, undefined, executor);
      const repeated = await this.definitionByCommand(executor, context.organizationId, input.commandId);
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 PromptDefinition payload를 사용할 수 없습니다");
        return checkedDefinition(repeated);
      }
      const current = await this.activeDefinition(executor, context.organizationId);
      if (!current || current.version !== input.expectedVersion)
        throw new Error("PromptDefinition version precondition이 일치하지 않습니다");
      checkedDefinition(current);
      await executor.query(
        "UPDATE prompt_definition_version SET status = 'superseded', active_guard_key = NONE, superseded_at = time::now() WHERE organization_id = $organization_id AND prompt_definition_version_id = $version_id;",
        { organization_id: context.organizationId, version_id: current.prompt_definition_version_id },
      );
      return checkedDefinition(
        await this.createDefinition(executor, context, input.commandId, requestHash, input.sections, current),
      );
    });
  }

  public async activateMemory(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly scope: "organization" | "user" | "agent";
      readonly subjectId?: string;
      readonly expectedVersion: number;
      readonly entries: readonly MemoryEntry[];
    },
  ): Promise<MemoryVersion> {
    validateEntries(input.entries);
    const requestHash = growthChecksum(input);
    const subjectId = input.scope === "organization" ? "organization" : (input.subjectId ?? "");
    if (!subjectId) throw new Error("Memory subject ID가 필요합니다");
    const key = input.scope === "organization" ? "organization" : `${input.scope}:${subjectId}`;
    return await this.database.transaction(async (executor) => {
      await this.organizations.verifyTenantContext(context, undefined, executor);
      if (input.scope === "user")
        await this.organizations.verifyOrganizationMember(subjectId, context.organizationId, executor);
      const repeated = await this.memoryByCommand(executor, context.organizationId, input.commandId);
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 Memory payload를 사용할 수 없습니다");
        return checkedMemory(repeated);
      }
      const current = await this.activeMemory(executor, context.organizationId, key);
      if (!current || current.version !== input.expectedVersion)
        throw new Error("Memory version precondition이 일치하지 않습니다");
      checkedMemory(current);
      await executor.query(
        "UPDATE memory_version SET status = 'superseded', active_guard_key = NONE, superseded_at = time::now() WHERE organization_id = $organization_id AND memory_version_id = $version_id;",
        { organization_id: context.organizationId, version_id: current.memory_version_id },
      );
      return checkedMemory(
        await this.createMemory(
          executor,
          context,
          input.commandId,
          requestHash,
          input.scope,
          subjectId,
          input.entries,
          current,
        ),
      );
    });
  }

  public async compose(
    context: TenantContext,
    input: ComposeEffectivePromptInput,
    executor: QueryExecutor,
  ): Promise<EffectivePromptVersion> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const [existing] = await executor.query<[PromptRecord[]]>(
      "SELECT * FROM prompt_version WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
      { organization_id: context.organizationId, work_id: input.workId },
    );
    if (existing[0]) return this.checkedPrompt(existing[0]);
    const activeDefinition = await this.activeDefinition(executor, context.organizationId);
    if (!activeDefinition) throw new Error("활성 PromptDefinitionVersion을 찾을 수 없습니다");
    checkedDefinition(activeDefinition);
    const memories: MemoryRecord[] = [];
    const organizationMemory = await this.activeMemory(executor, context.organizationId, "organization");
    if (organizationMemory) {
      checkedMemory(organizationMemory);
      memories.push(organizationMemory);
    }
    const userMemory = await this.activeMemory(executor, context.organizationId, `user:${input.requesterUserId}`);
    if (userMemory) {
      checkedMemory(userMemory);
      memories.push(userMemory);
    }
    const memoryLines = memories.flatMap((record) =>
      (JSON.parse(record.entries_json) as MemoryEntry[]).map(
        (entry) => `- [${entry.kind}:${entry.key}] ${entry.value}`,
      ),
    );
    const baseSections = JSON.parse(activeDefinition.sections_json) as PromptAgentSection[];
    const sections = baseSections.map((section) => ({
      ...section,
      instruction:
        memoryLines.length === 0
          ? section.instruction
          : `${section.instruction}\n채택된 장기 기억:\n${memoryLines.join("\n")}`,
    }));
    const promptVersionId = randomUUID();
    const recordWithoutChecksum: Omit<PromptRecord, "checksum"> = {
      prompt_version_id: promptVersionId,
      organization_id: context.organizationId,
      work_id: input.workId,
      requester_user_id: input.requesterUserId,
      schema_version: "massion.work.prompt.v1",
      composer_version: "massion.prompt-composer.v1",
      prompt_definition_version_id: activeDefinition.prompt_definition_version_id,
      prompt_definition_checksum: activeDefinition.checksum,
      organization_version_id: input.organizationVersionId,
      organization_checksum: input.organizationChecksum,
      ...(input.contextVersionId ? { context_version_id: input.contextVersionId } : {}),
      ...(input.contextChecksum ? { context_checksum: input.contextChecksum } : {}),
      ...(input.policyVersionId ? { policy_version_id: input.policyVersionId } : {}),
      ...(input.policyChecksum ? { policy_checksum: input.policyChecksum } : {}),
      memory_version_ids: memories.map((record) => record.memory_version_id),
      memory_checksums: memories.map((record) => record.checksum),
      agent_sections_json: canonicalGrowthJson(sections),
    };
    const checksum = growthChecksum(promptContent(recordWithoutChecksum));
    const [created] = await executor.query<[PromptRecord[]]>(
      `CREATE prompt_version CONTENT {
        prompt_version_id: $prompt_version_id, organization_id: $organization_id, work_id: $work_id,
        requester_user_id: $requester_user_id, schema_version: $schema_version, composer_version: $composer_version,
        prompt_definition_version_id: $prompt_definition_version_id, prompt_definition_checksum: $prompt_definition_checksum,
        organization_version_id: $organization_version_id, organization_checksum: $organization_checksum,
        context_version_id: $context_version_id, context_checksum: $context_checksum,
        policy_version_id: $policy_version_id, policy_checksum: $policy_checksum,
        memory_version_ids: $memory_version_ids, memory_checksums: $memory_checksums,
        agent_sections_json: $agent_sections_json, checksum: $checksum, created_at: time::now()
      } RETURN AFTER;`,
      { ...recordWithoutChecksum, checksum },
    );
    const record = created[0];
    if (!record) throw new Error("PromptVersion 생성 결과가 없습니다");
    await this.event(
      executor,
      "prompt_version_event",
      context.organizationId,
      promptVersionId,
      `compose:${input.workId}`,
      "composed",
    );
    return this.checkedPrompt(record);
  }

  public async getPromptVersion(context: TenantContext, promptVersionId: string): Promise<EffectivePromptVersion> {
    await this.organizations.verifyTenantContext(context);
    const record = await this.promptRecord(this.database, context.organizationId, promptVersionId);
    if (!record) throw new Error("PromptVersion을 찾을 수 없습니다");
    return this.checkedPrompt(record);
  }

  public async verifyPromptVersion(
    context: TenantContext,
    promptVersionId: string,
    executor: QueryExecutor,
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const record = await this.promptRecord(executor, context.organizationId, promptVersionId);
    if (!record) throw new Error("PromptVersion을 찾을 수 없습니다");
    this.checkedPrompt(record);
  }

  private checkedPrompt(record: PromptRecord): EffectivePromptVersion {
    if (growthChecksum(promptContent(record)) !== record.checksum)
      throw new Error("PromptVersion checksum이 일치하지 않습니다");
    return prompt(record);
  }

  private async activeDefinition(
    executor: QueryExecutor,
    organizationId: string,
  ): Promise<DefinitionRecord | undefined> {
    const [records] = await executor.query<[DefinitionRecord[]]>(
      "SELECT * FROM prompt_definition_version WHERE active_guard_key = $guard LIMIT 1;",
      { guard: `${organizationId}:prompt-definition` },
    );
    return records[0];
  }

  private async activeMemory(
    executor: QueryExecutor,
    organizationId: string,
    key: string,
  ): Promise<MemoryRecord | undefined> {
    const [records] = await executor.query<[MemoryRecord[]]>(
      "SELECT * FROM memory_version WHERE active_guard_key = $guard LIMIT 1;",
      { guard: `${organizationId}:memory:${key}` },
    );
    return records[0];
  }

  private async definitionByCommand(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
  ): Promise<DefinitionRecord | undefined> {
    const [records] = await executor.query<[DefinitionRecord[]]>(
      "SELECT * FROM prompt_definition_version WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }

  private async memoryByCommand(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
  ): Promise<MemoryRecord | undefined> {
    const [records] = await executor.query<[MemoryRecord[]]>(
      "SELECT * FROM memory_version WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }

  private async promptRecord(
    executor: QueryExecutor,
    organizationId: string,
    id: string,
  ): Promise<PromptRecord | undefined> {
    const [records] = await executor.query<[PromptRecord[]]>(
      "SELECT * FROM prompt_version WHERE organization_id = $organization_id AND prompt_version_id = $prompt_version_id LIMIT 1;",
      { organization_id: organizationId, prompt_version_id: id },
    );
    return records[0];
  }

  private async createDefinition(
    executor: QueryExecutor,
    context: TenantContext,
    commandId: string,
    requestHash: string,
    sections: readonly PromptAgentSection[],
    parent: DefinitionRecord | undefined,
  ): Promise<DefinitionRecord> {
    const id = randomUUID();
    const version = (parent?.version ?? 0) + 1;
    const checksum = growthChecksum({
      id,
      organizationId: context.organizationId,
      version,
      parentVersionId: parent?.prompt_definition_version_id,
      sections,
    });
    const [records] = await executor.query<[DefinitionRecord[]]>(
      "CREATE prompt_definition_version CONTENT { prompt_definition_version_id: $id, organization_id: $organization_id, version: $version, parent_version_id: $parent_id, status: 'active', sections_json: $sections_json, checksum: $checksum, command_id: $command_id, request_hash: $request_hash, active_guard_key: $guard, created_by_user_id: $user_id, created_at: time::now(), superseded_at: NONE } RETURN AFTER;",
      {
        id,
        organization_id: context.organizationId,
        version,
        parent_id: parent?.prompt_definition_version_id,
        sections_json: canonicalGrowthJson(sections),
        checksum,
        command_id: commandId,
        request_hash: requestHash,
        guard: `${context.organizationId}:prompt-definition`,
        user_id: context.userId,
      },
    );
    if (!records[0]) throw new Error("PromptDefinitionVersion 생성 결과가 없습니다");
    await this.event(executor, "prompt_definition_event", context.organizationId, id, commandId, "activated");
    return records[0];
  }

  private async createMemory(
    executor: QueryExecutor,
    context: TenantContext,
    commandId: string,
    requestHash: string,
    scope: "organization" | "user" | "agent",
    subjectId: string,
    entries: readonly MemoryEntry[],
    parent: MemoryRecord | undefined,
  ): Promise<MemoryRecord> {
    const id = randomUUID();
    const key = scope === "organization" ? "organization" : `${scope}:${subjectId}`;
    const version = (parent?.version ?? 0) + 1;
    const checksum = growthChecksum({
      id,
      organizationId: context.organizationId,
      scope,
      subjectId,
      version,
      parentVersionId: parent?.memory_version_id,
      entries,
    });
    const [records] = await executor.query<[MemoryRecord[]]>(
      "CREATE memory_version CONTENT { memory_version_id: $id, organization_id: $organization_id, scope: $scope, subject_id: $subject_id, subject_key: $subject_key, version: $version, parent_version_id: $parent_id, status: 'active', entries_json: $entries_json, checksum: $checksum, command_id: $command_id, request_hash: $request_hash, active_guard_key: $guard, created_by_user_id: $user_id, created_at: time::now(), superseded_at: NONE } RETURN AFTER;",
      {
        id,
        organization_id: context.organizationId,
        scope,
        subject_id: subjectId,
        subject_key: key,
        version,
        parent_id: parent?.memory_version_id,
        entries_json: canonicalGrowthJson(entries),
        checksum,
        command_id: commandId,
        request_hash: requestHash,
        guard: `${context.organizationId}:memory:${key}`,
        user_id: context.userId,
      },
    );
    if (!records[0]) throw new Error("MemoryVersion 생성 결과가 없습니다");
    await this.event(executor, "memory_version_event", context.organizationId, id, commandId, "activated");
    return records[0];
  }

  private async event(
    executor: QueryExecutor,
    table: string,
    organizationId: string,
    versionId: string,
    commandId: string,
    eventType: string,
  ): Promise<void> {
    if (!new Set(["prompt_definition_event", "memory_version_event", "prompt_version_event"]).has(table))
      throw new Error("지원하지 않는 version event table입니다");
    await executor.query(
      `CREATE ${table} CONTENT { event_id: $event_id, organization_id: $organization_id, version_id: $version_id, command_id: $command_id, event_type: $event_type, created_at: time::now() };`,
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        version_id: versionId,
        command_id: commandId,
        event_type: eventType,
      },
    );
  }
}
