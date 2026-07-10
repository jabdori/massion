import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { ApprovalStore } from "./approval-store.js";
import { createDefaultPolicy } from "./defaults.js";
import { GovernanceService } from "./governance-service.js";
import { PermitStore } from "./permit.js";
import { PolicyStore } from "./policy-store.js";
import { ApprovalRecovery } from "./recovery.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("remote Governance contract", () => {
  remoteTest("SurrealDB 3에서 Policy Version을 원자 활성화한다", async () => {
    const databaseName = `governance_${crypto.randomUUID().replaceAll("-", "")}`;
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
    const owner = await identity.registerPersonalUser({ email: "governance@example.com", displayName: "Governance" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await PolicyStore.create(database, organizations);
    const defaults = createDefaultPolicy("personal");
    const draft = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });

    const active = await store.activate(context, {
      commandId: crypto.randomUUID(),
      policyVersionId: draft.policy_version_id,
    });

    expect(await database.version()).toMatch(/^surrealdb-3\./u);
    expect(active.status).toBe("active");
    expect((await store.getActive(context))?.policy_version_id).toBe(active.policy_version_id);

    const governance = await GovernanceService.create(database, organizations, store);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const evaluate = async () =>
      await governance.evaluate(context, {
        commandId: crypto.randomUUID(),
        request: {
          principal: { type: "Human", id: context.userId, organizationId: context.organizationId },
          action: "tool.call",
          resource: { type: "Work", id: "work-remote", organizationId: context.organizationId, revision: 1 },
          context: { environment: "local", riskClass: "write", external: false },
        },
      });
    const decision = await evaluate();
    const requested = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: decision.decisionId,
      resourceRevision: 1,
      workId: "work-remote",
    });
    const other = await identity.registerPersonalUser({
      email: `governance-other-${databaseName}@example.com`,
      displayName: "Other Governance",
    });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(approvals.get(otherContext, requested.approval_id)).rejects.toThrow("Approval을 찾을 수 없습니다");
    const concurrentVotes = await Promise.allSettled([
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: requested.approval_id,
        vote: "approve",
        reason: "remote reviewed",
      }),
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: requested.approval_id,
        vote: "approve",
        reason: "remote concurrent duplicate",
      }),
    ]);
    expect(concurrentVotes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const approved = await approvals.get(context, requested.approval_id);
    expect(approved.status).toBe("approved");
    const consume = (executionId: string) =>
      permits.consume(context, {
        commandId: crypto.randomUUID(),
        approvalId: approved.approval_id,
        requestHash: decision.requestHash,
        policyVersionId: decision.policyVersionId ?? "",
        resourceRevision: 1,
        executionId,
      });
    const concurrent = await Promise.allSettled([consume("execution-a"), consume("execution-b")]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const pendingDecision = await evaluate();
    await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: pendingDecision.decisionId,
      resourceRevision: 1,
      workId: "work-pending",
    });
    expect(await new ApprovalRecovery(approvals).recover(context)).toEqual([
      expect.objectContaining({ workId: "work-pending", status: "pending" }),
    ]);
  });
});
