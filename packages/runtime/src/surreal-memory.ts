import type {
  Conversation,
  ConversationStepRecord,
  ConversationQueryOptions,
  CreateConversationInput,
  GetConversationStepsOptions,
  GetMessagesOptions,
  StorageAdapter,
  WorkflowRunQuery,
  WorkflowStateEntry,
  WorkingMemoryScope,
} from "@voltagent/core";
import type { UIMessage } from "ai";

import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { RUNTIME_MEMORY_MIGRATION } from "./schema.js";

interface ConversationRecord {
  readonly conversation_id: string;
  readonly organization_id: string;
  readonly resource_id: string;
  readonly user_id: string;
  readonly title: string;
  readonly metadata_json: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface MessageRecord {
  readonly message_id: string;
  readonly user_id: string;
  readonly conversation_id: string;
  readonly role: string;
  readonly message_json: string;
  readonly created_at: unknown;
}

interface WorkingMemoryRecord {
  readonly content: string;
}

interface ConversationStepDatabaseRecord {
  readonly step_id: string;
  readonly step_index: number;
  readonly step_json: string;
}

interface WorkflowRecord {
  readonly workflow_execution_id: string;
  readonly workflow_id: string;
  readonly workflow_name: string;
  readonly status: WorkflowStateEntry["status"];
  readonly user_id?: string;
  readonly metadata_json: string;
  readonly state_json: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface SurrealMemoryAdapterOptions {
  readonly organizationId: string;
}

function millis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return new Date(value).getTime();
  const serialized = JSON.stringify(value);
  const parsed = serialized ? (JSON.parse(serialized) as unknown) : undefined;
  return typeof parsed === "string" || typeof parsed === "number" ? new Date(parsed).getTime() : Number.NaN;
}

function iso(value: unknown): string {
  return new Date(millis(value)).toISOString();
}

function conversation(record: ConversationRecord): Conversation {
  return {
    id: record.conversation_id,
    resourceId: record.resource_id,
    userId: record.user_id,
    title: record.title,
    metadata: JSON.parse(record.metadata_json) as Record<string, unknown>,
    createdAt: iso(record.created_at),
    updatedAt: iso(record.updated_at),
  };
}

function restoreWorkflowDates(state: WorkflowStateEntry): WorkflowStateEntry {
  return {
    ...state,
    createdAt: new Date(state.createdAt),
    updatedAt: new Date(state.updatedAt),
    ...(state.suspension
      ? { suspension: { ...state.suspension, suspendedAt: new Date(state.suspension.suspendedAt) } }
      : {}),
    ...(state.cancellation
      ? { cancellation: { ...state.cancellation, cancelledAt: new Date(state.cancellation.cancelledAt) } }
      : {}),
  };
}

export class SurrealMemoryAdapter implements StorageAdapter {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizationId: string,
  ) {}

  public static async create(
    database: MassionDatabase,
    options: SurrealMemoryAdapterOptions,
  ): Promise<SurrealMemoryAdapter> {
    if (!options.organizationId.trim()) throw new Error("Memory Adapter organizationId가 필요합니다");
    await applyMigrations(database, [RUNTIME_MEMORY_MIGRATION]);
    return new SurrealMemoryAdapter(database, options.organizationId);
  }

  public async addMessage(message: UIMessage, userId: string, conversationId: string): Promise<void> {
    await this.addMessages([message], userId, conversationId);
  }

  public async addMessages(messages: UIMessage[], userId: string, conversationId: string): Promise<void> {
    await this.requireConversation(conversationId, userId);
    await this.database.transaction(async (tx) => {
      for (const message of messages) {
        const [existing] = await tx.query<[MessageRecord[]]>(
          "SELECT message_id FROM runtime_message WHERE organization_id = $organization_id AND conversation_id = $conversation_id AND message_id = $message_id LIMIT 1;",
          { organization_id: this.organizationId, conversation_id: conversationId, message_id: message.id },
        );
        if (existing[0]) continue;
        await tx.query(
          "CREATE runtime_message CONTENT { message_id: $message_id, organization_id: $organization_id, user_id: $user_id, conversation_id: $conversation_id, role: $role, message_json: $message_json, created_at: time::now() };",
          {
            message_id: message.id,
            organization_id: this.organizationId,
            user_id: userId,
            conversation_id: conversationId,
            role: message.role,
            message_json: JSON.stringify(message),
          },
        );
      }
    });
  }

  public async getMessages(
    userId: string,
    conversationId: string,
    options: GetMessagesOptions = {},
  ): Promise<Array<UIMessage<{ createdAt: Date }>>> {
    const [records] = await this.database.query<[MessageRecord[]]>(
      "SELECT * OMIT id FROM runtime_message WHERE organization_id = $organization_id AND user_id = $user_id AND conversation_id = $conversation_id ORDER BY created_at ASC, message_id ASC;",
      { organization_id: this.organizationId, user_id: userId, conversation_id: conversationId },
    );
    const before = options.before?.getTime() ?? Number.POSITIVE_INFINITY;
    const after = options.after?.getTime() ?? Number.NEGATIVE_INFINITY;
    const roles = options.roles ? new Set(options.roles) : undefined;
    const filtered = records.filter((record) => {
      const timestamp = millis(record.created_at);
      return timestamp < before && timestamp > after && (!roles || roles.has(record.role));
    });
    const limited = options.limit === undefined ? filtered : filtered.slice(-options.limit);
    return limited.map((record): UIMessage<{ createdAt: Date }> => ({
      ...(JSON.parse(record.message_json) as UIMessage),
      metadata: { createdAt: new Date(millis(record.created_at)) },
    }));
  }

  public async clearMessages(userId: string, conversationId?: string): Promise<void> {
    await this.database.query(
      "DELETE runtime_message WHERE organization_id = $organization_id AND user_id = $user_id AND ($conversation_id = NONE OR conversation_id = $conversation_id);",
      { organization_id: this.organizationId, user_id: userId, conversation_id: conversationId },
    );
  }

  public async deleteMessages(messageIds: string[], userId: string, conversationId: string): Promise<void> {
    if (messageIds.length === 0) return;
    await this.database.query(
      "DELETE runtime_message WHERE organization_id = $organization_id AND user_id = $user_id AND conversation_id = $conversation_id AND message_id IN $message_ids;",
      {
        organization_id: this.organizationId,
        user_id: userId,
        conversation_id: conversationId,
        message_ids: messageIds,
      },
    );
  }

  public async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const [records] = await this.database.query<[ConversationRecord[]]>(
      "CREATE runtime_conversation CONTENT { conversation_id: $conversation_id, organization_id: $organization_id, resource_id: $resource_id, user_id: $user_id, title: $title, metadata_json: $metadata_json, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
      {
        conversation_id: input.id,
        organization_id: this.organizationId,
        resource_id: input.resourceId,
        user_id: input.userId,
        title: input.title,
        metadata_json: JSON.stringify(input.metadata),
      },
    );
    if (!records[0]) throw new Error("Runtime Conversation 생성 결과가 없습니다");
    return conversation(records[0]);
  }

  public async getConversation(id: string): Promise<Conversation | null> {
    const [records] = await this.database.query<[ConversationRecord[]]>(
      "SELECT * OMIT id FROM runtime_conversation WHERE organization_id = $organization_id AND conversation_id = $conversation_id LIMIT 1;",
      { organization_id: this.organizationId, conversation_id: id },
    );
    return records[0] ? conversation(records[0]) : null;
  }

  public async getConversations(resourceId: string): Promise<Conversation[]> {
    return await this.queryConversations({ resourceId });
  }

  public async getConversationsByUserId(
    userId: string,
    options: Omit<ConversationQueryOptions, "userId"> = {},
  ): Promise<Conversation[]> {
    return await this.queryConversations({ ...options, userId });
  }

  public async queryConversations(options: ConversationQueryOptions): Promise<Conversation[]> {
    const [records] = await this.database.query<[ConversationRecord[]]>(
      "SELECT * OMIT id FROM runtime_conversation WHERE organization_id = $organization_id;",
      { organization_id: this.organizationId },
    );
    const filtered = records.filter(
      (record) =>
        (!options.userId || record.user_id === options.userId) &&
        (!options.resourceId || record.resource_id === options.resourceId),
    );
    const orderBy = options.orderBy ?? "updated_at";
    const direction = options.orderDirection === "ASC" ? 1 : -1;
    filtered.sort((left, right) => {
      const leftValue =
        orderBy === "title" ? left.title : millis(orderBy === "created_at" ? left.created_at : left.updated_at);
      const rightValue =
        orderBy === "title" ? right.title : millis(orderBy === "created_at" ? right.created_at : right.updated_at);
      return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) * direction;
    });
    return filtered
      .slice(options.offset ?? 0, options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit)
      .map(conversation);
  }

  public async countConversations(options: ConversationQueryOptions): Promise<number> {
    const filters = { ...options };
    delete filters.limit;
    delete filters.offset;
    return (await this.queryConversations(filters)).length;
  }

  public async updateConversation(
    id: string,
    updates: Partial<Omit<Conversation, "id" | "createdAt" | "updatedAt">>,
  ): Promise<Conversation> {
    const current = await this.getConversation(id);
    if (!current) throw new Error(`Runtime Conversation을 찾을 수 없습니다: ${id}`);
    const next = { ...current, ...updates };
    const [records] = await this.database.query<[ConversationRecord[]]>(
      "UPDATE runtime_conversation SET resource_id = $resource_id, user_id = $user_id, title = $title, metadata_json = $metadata_json, updated_at = time::now() WHERE organization_id = $organization_id AND conversation_id = $conversation_id RETURN AFTER;",
      {
        organization_id: this.organizationId,
        conversation_id: id,
        resource_id: next.resourceId,
        user_id: next.userId,
        title: next.title,
        metadata_json: JSON.stringify(next.metadata),
      },
    );
    if (!records[0]) throw new Error("Runtime Conversation 갱신 결과가 없습니다");
    return conversation(records[0]);
  }

  public async deleteConversation(id: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query(
        "DELETE runtime_message WHERE organization_id = $organization_id AND conversation_id = $conversation_id; DELETE runtime_conversation_step WHERE organization_id = $organization_id AND conversation_id = $conversation_id; DELETE runtime_conversation WHERE organization_id = $organization_id AND conversation_id = $conversation_id;",
        { organization_id: this.organizationId, conversation_id: id },
      );
    });
  }

  public async saveConversationSteps(steps: ConversationStepRecord[]): Promise<void> {
    await this.database.transaction(async (tx) => {
      for (const step of steps) {
        const [existing] = await tx.query<[ConversationStepDatabaseRecord[]]>(
          "SELECT step_id FROM runtime_conversation_step WHERE organization_id = $organization_id AND step_id = $step_id LIMIT 1;",
          { organization_id: this.organizationId, step_id: step.id },
        );
        if (existing[0]) continue;
        await tx.query(
          "CREATE runtime_conversation_step CONTENT { step_id: $step_id, organization_id: $organization_id, user_id: $user_id, conversation_id: $conversation_id, operation_id: $operation_id, step_index: $step_index, step_json: $step_json, created_at: $created_at };",
          {
            step_id: step.id,
            organization_id: this.organizationId,
            user_id: step.userId,
            conversation_id: step.conversationId,
            operation_id: step.operationId,
            step_index: step.stepIndex,
            step_json: JSON.stringify(step),
            created_at: new Date(step.createdAt),
          },
        );
      }
    });
  }

  public async getConversationSteps(
    userId: string,
    conversationId: string,
    options: GetConversationStepsOptions = {},
  ): Promise<ConversationStepRecord[]> {
    const [records] = await this.database.query<[ConversationStepDatabaseRecord[]]>(
      "SELECT step_id, step_index, step_json FROM runtime_conversation_step WHERE organization_id = $organization_id AND user_id = $user_id AND conversation_id = $conversation_id AND ($operation_id = NONE OR operation_id = $operation_id) ORDER BY step_index ASC, step_id ASC;",
      {
        organization_id: this.organizationId,
        user_id: userId,
        conversation_id: conversationId,
        operation_id: options.operationId,
      },
    );
    const limited = options.limit === undefined ? records : records.slice(-options.limit);
    return limited.map((record) => JSON.parse(record.step_json) as ConversationStepRecord);
  }

  public async getWorkingMemory(params: {
    conversationId?: string;
    userId?: string;
    scope: WorkingMemoryScope;
  }): Promise<string | null> {
    const [records] = await this.database.query<[WorkingMemoryRecord[]]>(
      "SELECT content FROM runtime_working_memory WHERE organization_id = $organization_id AND memory_id = $memory_id LIMIT 1;",
      { organization_id: this.organizationId, memory_id: this.memoryId(params) },
    );
    return records[0]?.content ?? null;
  }

  public async setWorkingMemory(params: {
    conversationId?: string;
    userId?: string;
    content: string;
    scope: WorkingMemoryScope;
  }): Promise<void> {
    const memoryId = this.memoryId(params);
    await this.database.transaction(async (tx) => {
      const [records] = await tx.query<[WorkingMemoryRecord[]]>(
        "SELECT content FROM runtime_working_memory WHERE organization_id = $organization_id AND memory_id = $memory_id LIMIT 1;",
        { organization_id: this.organizationId, memory_id: memoryId },
      );
      if (records[0]) {
        await tx.query(
          "UPDATE runtime_working_memory SET content = $content, updated_at = time::now() WHERE organization_id = $organization_id AND memory_id = $memory_id;",
          { organization_id: this.organizationId, memory_id: memoryId, content: params.content },
        );
      } else {
        await tx.query(
          "CREATE runtime_working_memory CONTENT { memory_id: $memory_id, organization_id: $organization_id, scope: $scope, user_id: $user_id, conversation_id: $conversation_id, content: $content, created_at: time::now(), updated_at: time::now() };",
          {
            memory_id: memoryId,
            organization_id: this.organizationId,
            scope: params.scope,
            user_id: params.userId,
            conversation_id: params.conversationId,
            content: params.content,
          },
        );
      }
    });
  }

  public async deleteWorkingMemory(params: {
    conversationId?: string;
    userId?: string;
    scope: WorkingMemoryScope;
  }): Promise<void> {
    await this.database.query(
      "DELETE runtime_working_memory WHERE organization_id = $organization_id AND memory_id = $memory_id;",
      { organization_id: this.organizationId, memory_id: this.memoryId(params) },
    );
  }

  public async getWorkflowState(executionId: string): Promise<WorkflowStateEntry | null> {
    const [records] = await this.database.query<[WorkflowRecord[]]>(
      "SELECT * OMIT id FROM runtime_workflow_state WHERE organization_id = $organization_id AND workflow_execution_id = $execution_id LIMIT 1;",
      { organization_id: this.organizationId, execution_id: executionId },
    );
    return records[0] ? restoreWorkflowDates(JSON.parse(records[0].state_json) as WorkflowStateEntry) : null;
  }

  public async queryWorkflowRuns(query: WorkflowRunQuery): Promise<WorkflowStateEntry[]> {
    const [records] = await this.database.query<[WorkflowRecord[]]>(
      "SELECT * OMIT id FROM runtime_workflow_state WHERE organization_id = $organization_id;",
      { organization_id: this.organizationId },
    );
    const filtered = records.filter((record) => {
      const metadata = JSON.parse(record.metadata_json) as Record<string, unknown>;
      const metadataMatches =
        !query.metadata || Object.entries(query.metadata).every(([key, value]) => metadata[key] === value);
      const updated = millis(record.updated_at);
      return (
        (!query.workflowId || record.workflow_id === query.workflowId) &&
        (!query.status || record.status === query.status) &&
        (!query.userId || record.user_id === query.userId) &&
        (!query.from || updated >= query.from.getTime()) &&
        (!query.to || updated <= query.to.getTime()) &&
        metadataMatches
      );
    });
    filtered.sort((left, right) => millis(right.updated_at) - millis(left.updated_at));
    return filtered
      .slice(query.offset ?? 0, query.limit === undefined ? undefined : (query.offset ?? 0) + query.limit)
      .map((record) => restoreWorkflowDates(JSON.parse(record.state_json) as WorkflowStateEntry));
  }

  public async setWorkflowState(executionId: string, state: WorkflowStateEntry): Promise<void> {
    if (executionId !== state.id) throw new Error("Workflow execution ID가 state ID와 다릅니다");
    const existing = await this.getWorkflowState(executionId);
    if (existing) {
      await this.writeWorkflowState(state, true);
    } else {
      await this.writeWorkflowState(state, false);
    }
  }

  public async updateWorkflowState(executionId: string, updates: Partial<WorkflowStateEntry>): Promise<void> {
    const current = await this.getWorkflowState(executionId);
    if (!current) throw new Error(`Workflow state를 찾을 수 없습니다: ${executionId}`);
    await this.writeWorkflowState({ ...current, ...updates, id: executionId, updatedAt: new Date() }, true);
  }

  public async getSuspendedWorkflowStates(workflowId: string): Promise<WorkflowStateEntry[]> {
    return await this.queryWorkflowRuns({ workflowId, status: "suspended" });
  }

  private async requireConversation(conversationId: string, userId: string): Promise<Conversation> {
    const value = await this.getConversation(conversationId);
    if (!value || value.userId !== userId) throw new Error("Runtime Conversation을 찾을 수 없거나 user가 다릅니다");
    return value;
  }

  private memoryId(params: { conversationId?: string; userId?: string; scope: WorkingMemoryScope }): string {
    if (params.scope === "conversation") {
      if (!params.conversationId) throw new Error("conversation scope에는 conversationId가 필요합니다");
      return `conversation:${params.conversationId}`;
    }
    if (!params.userId) throw new Error("user scope에는 userId가 필요합니다");
    return `user:${params.userId}`;
  }

  private async writeWorkflowState(state: WorkflowStateEntry, update: boolean): Promise<void> {
    const bindings = {
      organization_id: this.organizationId,
      execution_id: state.id,
      workflow_id: state.workflowId,
      workflow_name: state.workflowName,
      status: state.status,
      user_id: state.userId,
      metadata_json: JSON.stringify(state.metadata ?? {}),
      state_json: JSON.stringify(state),
      created_at: state.createdAt,
    };
    await this.database.query(
      update
        ? "UPDATE runtime_workflow_state SET workflow_id = $workflow_id, workflow_name = $workflow_name, status = $status, user_id = $user_id, metadata_json = $metadata_json, state_json = $state_json, updated_at = time::now() WHERE organization_id = $organization_id AND workflow_execution_id = $execution_id;"
        : "CREATE runtime_workflow_state CONTENT { workflow_execution_id: $execution_id, organization_id: $organization_id, workflow_id: $workflow_id, workflow_name: $workflow_name, status: $status, user_id: $user_id, metadata_json: $metadata_json, state_json: $state_json, created_at: $created_at, updated_at: time::now() };",
      bindings,
    );
  }
}
