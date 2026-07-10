import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { RuntimeExecutionStore } from "./execution-store.js";
import { SurrealMemoryAdapter } from "./surreal-memory.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("remote Runtime contract", () => {
  remoteTest("원격 SurrealDB에서 execution·conversation·workflow state를 원자 영속한다", async () => {
    const databaseName = `runtime_${crypto.randomUUID().replaceAll("-", "")}`;
    const sqlUrl = (remoteUrl ?? "")
      .replace(/^ws:/u, "http:")
      .replace(/^wss:/u, "https:")
      .replace(/\/rpc$/u, "/sql");
    const provisioned = await fetch(sqlUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
        accept: "application/json",
        "content-type": "text/plain",
      },
      body: `DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS ${databaseName};`,
    });
    if (!provisioned.ok) throw new Error(`SurrealDB 원격 테스트 프로비저닝 실패: ${String(provisioned.status)}`);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const executions = await RuntimeExecutionStore.create(database, organizations);
    const created = await executions.createExecution(context, {
      commandId: crypto.randomUUID(),
      workId: "work-remote",
      agentHandle: "representative",
      modelRoute: "planning-quality",
      correlationId: "remote",
      input: { remote: true },
    });
    const running = await executions.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    const memory = await SurrealMemoryAdapter.create(database, { organizationId: context.organizationId });
    await memory.createConversation({
      id: "conversation-remote",
      resourceId: "representative",
      userId: context.userId,
      title: "Remote",
      metadata: { executionId: created.execution.execution_id },
    });
    await memory.addMessage(
      { id: "message-remote", role: "user", parts: [{ type: "text", text: "remote" }] },
      context.userId,
      "conversation-remote",
    );
    const now = new Date();
    await memory.setWorkflowState("workflow-remote", {
      id: "workflow-remote",
      workflowId: "delivery",
      workflowName: "Delivery",
      status: "suspended",
      suspension: { suspendedAt: now, stepIndex: 1 },
      createdAt: now,
      updatedAt: now,
    });

    expect(await database.version()).toMatch(/^surrealdb-3\./u);
    expect(running.execution.status).toBe("running");
    expect(await memory.getMessages(context.userId, "conversation-remote")).toHaveLength(1);
    expect((await memory.getWorkflowState("workflow-remote"))?.suspension?.suspendedAt).toBeInstanceOf(Date);
  });
});
