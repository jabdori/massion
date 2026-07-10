import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type MassionDatabase } from "@massion/storage";

import { SurrealMemoryAdapter } from "./surreal-memory.js";

describe("SurrealDB VoltAgent StorageAdapter", () => {
  let database: MassionDatabase;
  let memory: SurrealMemoryAdapter;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    memory = await SurrealMemoryAdapter.create(database, { organizationId: "organization-a" });
  });

  afterEach(async () => database.close());

  it("conversation CRUD·query·count를 tenant 범위에서 제공한다", async () => {
    const created = await memory.createConversation({
      id: "conversation-1",
      resourceId: "representative",
      userId: "user-1",
      title: "First",
      metadata: { workId: "work-1" },
    });
    await memory.createConversation({
      id: "conversation-2",
      resourceId: "representative",
      userId: "user-1",
      title: "Second",
      metadata: {},
    });
    const updated = await memory.updateConversation(created.id, { title: "Updated", metadata: { revision: 2 } });

    expect(updated.title).toBe("Updated");
    expect(await memory.queryConversations({ userId: "user-1", orderBy: "title", orderDirection: "ASC" })).toHaveLength(
      2,
    );
    expect(await memory.countConversations({ resourceId: "representative", limit: 1 })).toBe(2);
    const other = await SurrealMemoryAdapter.create(database, { organizationId: "organization-b" });
    expect(await other.getConversation(created.id)).toBeNull();
    await memory.deleteConversation(created.id);
    expect(await memory.getConversation(created.id)).toBeNull();
  });

  it("message batch·시간·role pagination과 선택 삭제를 보존한다", async () => {
    await memory.createConversation({
      id: "conversation-1",
      resourceId: "representative",
      userId: "user-1",
      title: "Messages",
      metadata: {},
    });
    await memory.addMessages(
      [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "world" }] },
      ],
      "user-1",
      "conversation-1",
    );
    const messages = await memory.getMessages("user-1", "conversation-1", { roles: ["assistant"], limit: 1 });
    expect(messages.map((message) => message.id)).toEqual(["m2"]);
    expect(messages[0]?.metadata?.createdAt).toBeInstanceOf(Date);
    await memory.deleteMessages(["m1"], "user-1", "conversation-1");
    expect((await memory.getMessages("user-1", "conversation-1")).map((message) => message.id)).toEqual(["m2"]);
    await memory.clearMessages("user-1", "conversation-1");
    expect(await memory.getMessages("user-1", "conversation-1")).toEqual([]);
  });

  it("conversation·user working memory scope를 분리한다", async () => {
    await memory.setWorkingMemory({
      conversationId: "c1",
      userId: "u1",
      scope: "conversation",
      content: "conversation",
    });
    await memory.setWorkingMemory({ userId: "u1", scope: "user", content: "user" });
    expect(await memory.getWorkingMemory({ conversationId: "c1", userId: "u1", scope: "conversation" })).toBe(
      "conversation",
    );
    expect(await memory.getWorkingMemory({ userId: "u1", scope: "user" })).toBe("user");
    await memory.deleteWorkingMemory({ conversationId: "c1", userId: "u1", scope: "conversation" });
    expect(await memory.getWorkingMemory({ conversationId: "c1", userId: "u1", scope: "conversation" })).toBeNull();
  });

  it("workflow state의 Date·suspend checkpoint를 roundtrip하고 query·update한다", async () => {
    const createdAt = new Date("2030-01-01T00:00:00Z");
    await memory.setWorkflowState("wf-execution-1", {
      id: "wf-execution-1",
      workflowId: "delivery",
      workflowName: "Delivery",
      status: "suspended",
      suspension: { suspendedAt: createdAt, stepIndex: 2, checkpoint: { workflowState: { completed: 1 } } },
      createdAt,
      updatedAt: createdAt,
    });
    await memory.updateWorkflowState("wf-execution-1", { metadata: { workId: "work-1" } });
    const restored = await memory.getWorkflowState("wf-execution-1");

    expect(restored?.createdAt).toBeInstanceOf(Date);
    expect(restored?.suspension?.suspendedAt).toBeInstanceOf(Date);
    expect(restored?.metadata).toEqual({ workId: "work-1" });
    expect(await memory.getSuspendedWorkflowStates("delivery")).toHaveLength(1);
    expect(await memory.queryWorkflowRuns({ status: "suspended", workflowId: "delivery" })).toHaveLength(1);
  });

  it("conversation step의 tool·subagent 귀속과 operation filter를 저장한다", async () => {
    await memory.saveConversationSteps([
      {
        id: "step-1",
        conversationId: "conversation-1",
        userId: "user-1",
        agentId: "agent-1",
        agentName: "representative",
        operationId: "operation-1",
        stepIndex: 0,
        type: "tool_call",
        role: "assistant",
        arguments: { query: "evidence" },
        subAgentId: "agent-2",
        subAgentName: "evidence-research",
        createdAt: "2030-01-01T00:00:00.000Z",
      },
      {
        id: "step-2",
        conversationId: "conversation-1",
        userId: "user-1",
        agentId: "agent-1",
        operationId: "operation-2",
        stepIndex: 1,
        type: "text",
        role: "assistant",
        content: "done",
        createdAt: "2030-01-01T00:00:01.000Z",
      },
    ]);

    const steps = await memory.getConversationSteps("user-1", "conversation-1", {
      operationId: "operation-1",
      limit: 1,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.subAgentName).toBe("evidence-research");
    expect(steps[0]?.arguments).toEqual({ query: "evidence" });
  });
});
