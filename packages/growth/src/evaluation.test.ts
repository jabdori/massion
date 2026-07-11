import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { GrowthEvaluationStore, decideGrowthEvaluation, type GrowthSignalReceiptInput } from "./evaluation.js";
import { GROWTH_EVALUATION_MIGRATION } from "./schema.js";

describe("versioned Growth evaluation", () => {
  it("0057 Growth evaluation migration checksum을 고정한다", () => {
    expect(GROWTH_EVALUATION_MIGRATION.id).toBe("0057-growth-evaluation");
    expect(GROWTH_EVALUATION_MIGRATION.checksum).toBe(
      "d7ad59b4dcd17fee5d8e295600f6f964c1c5b8f1fbb577fde24c0a5f47609e16",
    );
  });

  const required = (id: string): GrowthSignalReceiptInput => ({
    commandId: `signal-${id}`,
    suggestionId: "suggestion-1",
    signalId: id,
    group: "required",
    origin: "deterministic",
    adapterId: `adapter-${id}`,
    adapterVersion: "1.0.0",
    outcome: "passed",
    score: 1,
    unit: "ratio",
    sourceId: `source-${id}`,
    sourceChecksum: "a".repeat(64),
    fresh: true,
    evidence: { result: "passed" },
  });
  const supporting = (origin: "independent" | "model-self" = "independent"): GrowthSignalReceiptInput => ({
    ...required(`support-${origin}`),
    group: "supporting",
    origin,
  });

  it("required·독립 supporting·conflict gate를 결정론적으로 판정한다", () => {
    expect(
      decideGrowthEvaluation({
        required: [required("lineage"), required("target"), required("candidate")],
        supporting: [supporting()],
        conflicts: [],
      }),
    ).toBe("eligible");
    expect(
      decideGrowthEvaluation({
        required: [required("lineage")],
        supporting: [supporting("model-self")],
        conflicts: [],
      }),
    ).toBe("blocked");
    expect(
      decideGrowthEvaluation({
        required: [required("lineage"), required("target"), required("candidate")],
        supporting: [supporting()],
        conflicts: [{ ...required("security"), group: "conflict" }],
      }),
    ).toBe("ineligible");
  });

  let database: MassionDatabase;
  let context: TenantContext;
  let otherContext: TenantContext;
  let store: GrowthEvaluationStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "evaluation@example.com", displayName: "Evaluation" });
    const other = await identity.registerPersonalUser({ email: "evaluation-other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    store = await GrowthEvaluationStore.create(database, organizations);
    await store.bootstrap(context);
  });

  afterEach(async () => database.close());

  it("초기 evidence-gated strategy를 version 정본으로 만들고 교체한다", async () => {
    const first = await store.getActiveStrategy(context);
    const second = await store.activateStrategy(context, {
      commandId: "strategy-v2",
      expectedVersion: 1,
      governanceDecisionId: "decision-strategy-v2",
      strategy: { ...first.strategy, strategyId: "massion.growth.evidence-gated.v2" },
    });

    expect(first.strategy.strategyId).toBe("massion.growth.evidence-gated.v1");
    expect(second.version).toBe(2);
    expect(second.parentVersionId).toBe(first.strategyVersionId);
    await expect(
      store.activateStrategy(context, {
        commandId: "stale-strategy",
        expectedVersion: 1,
        governanceDecisionId: "decision-stale",
        strategy: first.strategy,
      }),
    ).rejects.toThrow("precondition");
  });

  it("signal receipt의 finite score·checksum·freshness·command 멱등을 강제한다", async () => {
    const input = required("lineage");
    const receipt = await store.recordSignal(context, input);

    await expect(store.recordSignal(context, input)).resolves.toEqual(receipt);
    await expect(store.recordSignal(context, { ...input, score: 0.5 })).rejects.toThrow("같은 commandId");
    await expect(store.recordSignal(context, { ...input, commandId: "nan", score: Number.NaN })).rejects.toThrow(
      "finite",
    );
    await expect(store.recordSignal(context, { ...input, commandId: "stale", fresh: false })).rejects.toThrow("fresh");
    await expect(store.getSignal(otherContext, receipt.receiptId)).rejects.toThrow("찾을 수 없습니다");
  });

  it("active strategy JSON과 저장된 receipt만으로 evaluation outcome을 만든다", async () => {
    const inputs = [required("lineage"), required("target"), required("candidate"), supporting()].map(
      (input, index) => ({ ...input, commandId: `evaluation-signal-${String(index)}` }),
    );
    const receipts = await Promise.all(inputs.map(async (input) => await store.recordSignal(context, input)));

    const evaluation = await store.evaluate(context, {
      commandId: "evaluation-run-1",
      suggestionId: "suggestion-1",
      receiptIds: receipts.map((receipt) => receipt.receiptId),
    });

    expect(evaluation).toMatchObject({ outcome: "eligible", suggestionId: "suggestion-1" });
    const wrongUnit = await store.recordSignal(context, {
      ...required("unit-mismatch"),
      commandId: "unit-mismatch",
      unit: "meters",
    });
    await expect(
      store.evaluate(context, {
        commandId: "evaluation-unit-mismatch",
        suggestionId: "suggestion-1",
        receiptIds: [...receipts.map((receipt) => receipt.receiptId), wrongUnit.receiptId],
      }),
    ).resolves.toMatchObject({ outcome: "blocked" });
  });
});
