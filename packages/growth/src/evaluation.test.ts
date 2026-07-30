import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  GrowthEvaluationIntegrityError,
  GrowthEvaluationStore,
  decideGrowthEvaluation,
  growthEvaluationInputHash,
  type GrowthEvaluationOutcome,
  type GrowthSignalReceiptInput,
} from "./evaluation.js";
import { canonicalGrowthJson, growthChecksum } from "./prompt-memory.js";
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

  const eligibleInputs = (suggestionId: string, commandPrefix = suggestionId): GrowthSignalReceiptInput[] =>
    [required("lineage"), required("target"), required("candidate"), supporting()].map((input, index) => ({
      ...input,
      suggestionId,
      commandId: `${commandPrefix}-signal-${String(index)}`,
    }));

  async function createRawReceipt(
    input: GrowthSignalReceiptInput,
    options: {
      readonly receiptId?: string;
      readonly stored?: Partial<GrowthSignalReceiptInput>;
      readonly evidenceJson?: string;
      readonly requestHash?: string;
    } = {},
  ): Promise<{ readonly receiptId: string; readonly requestHash: string }> {
    const stored = { ...input, ...options.stored };
    const receiptId = options.receiptId ?? `receipt-${input.commandId}`;
    const requestHash = options.requestHash ?? growthChecksum(input);
    await database.query(
      "CREATE growth_signal_receipt CONTENT { receipt_id: $receipt_id, organization_id: $organization_id, suggestion_id: $suggestion_id, signal_id: $signal_id, signal_group: $signal_group, origin: $origin, adapter_id: $adapter_id, adapter_version: $adapter_version, outcome: $outcome, score: $score, unit: $unit, source_id: $source_id, source_checksum: $source_checksum, fresh: $fresh, evidence_json: $evidence_json, command_id: $command_id, request_hash: $request_hash, created_at: time::now() };",
      {
        receipt_id: receiptId,
        organization_id: context.organizationId,
        suggestion_id: stored.suggestionId,
        signal_id: stored.signalId,
        signal_group: stored.group,
        origin: stored.origin,
        adapter_id: stored.adapterId,
        adapter_version: stored.adapterVersion,
        outcome: stored.outcome,
        score: stored.score,
        unit: stored.unit,
        source_id: stored.sourceId,
        source_checksum: stored.sourceChecksum,
        fresh: stored.fresh,
        evidence_json: options.evidenceJson ?? canonicalGrowthJson(stored.evidence),
        command_id: stored.commandId,
        request_hash: requestHash,
      },
    );
    return { receiptId, requestHash };
  }

  async function createRawEvaluation(input: {
    readonly evaluationRunId: string;
    readonly suggestionId: string;
    readonly strategyVersionId: string;
    readonly receiptIds: readonly string[];
    readonly inputHash: string;
    readonly outcome: GrowthEvaluationOutcome;
    readonly organizationId?: string;
    readonly commandId?: string;
    readonly requestHash?: string;
  }): Promise<void> {
    const commandId = input.commandId ?? input.evaluationRunId;
    await database.query(
      "CREATE growth_evaluation_run CONTENT { evaluation_run_id: $evaluation_run_id, organization_id: $organization_id, suggestion_id: $suggestion_id, strategy_version_id: $strategy_version_id, receipt_ids: $receipt_ids, input_hash: $input_hash, outcome: $outcome, reason_json: '{}', command_id: $command_id, request_hash: $request_hash, created_at: type::datetime('2099-01-01T00:00:00.000Z') };",
      {
        evaluation_run_id: input.evaluationRunId,
        organization_id: input.organizationId ?? context.organizationId,
        suggestion_id: input.suggestionId,
        strategy_version_id: input.strategyVersionId,
        receipt_ids: input.receiptIds,
        input_hash: input.inputHash,
        outcome: input.outcome,
        command_id: commandId,
        request_hash:
          input.requestHash ??
          growthChecksum({ commandId, suggestionId: input.suggestionId, receiptIds: input.receiptIds }),
      },
    );
  }

  async function createRawStrategy(input: {
    readonly strategyVersionId: string;
    readonly strategyJson: string;
    readonly checksum: string;
    readonly organizationId?: string;
    readonly commandId?: string;
    readonly requestHash?: string;
  }): Promise<void> {
    const commandId = input.commandId ?? `command-${input.strategyVersionId}`;
    await database.query(
      "CREATE growth_evaluation_strategy_version CONTENT { strategy_version_id: $strategy_version_id, organization_id: $organization_id, version: 100, status: 'superseded', strategy_json: $strategy_json, checksum: $checksum, governance_decision_id: $governance_decision_id, command_id: $command_id, request_hash: $request_hash, active_guard_key: NONE, created_at: time::now() };",
      {
        strategy_version_id: input.strategyVersionId,
        organization_id: input.organizationId ?? context.organizationId,
        strategy_json: input.strategyJson,
        checksum: input.checksum,
        governance_decision_id: `decision-${input.strategyVersionId}`,
        command_id: commandId,
        request_hash: input.requestHash ?? growthChecksum({ strategyVersionId: input.strategyVersionId }),
      },
    );
  }

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
    const activation = {
      commandId: "strategy-v2",
      expectedVersion: 1,
      governanceDecisionId: "decision-strategy-v2",
      strategy: { ...first.strategy, strategyId: "massion.growth.evidence-gated.v2" },
    } as const;
    const second = await store.activateStrategy(context, activation);

    expect(first.strategy.strategyId).toBe("massion.growth.evidence-gated.v1");
    expect(second.version).toBe(2);
    expect(second.parentVersionId).toBe(first.strategyVersionId);
    await expect(store.activateStrategy(context, activation)).resolves.toEqual(second);
    await expect(
      store.activateStrategy(context, {
        commandId: "stale-strategy",
        expectedVersion: 1,
        governanceDecisionId: "decision-stale",
        strategy: first.strategy,
      }),
    ).rejects.toThrow("precondition");
  });

  it.each(["corrupt-json", "foreign-tenant"] as const)(
    "active strategy %s 반환은 tenant fence에서 typed integrity error로 수렴한다",
    async (mode) => {
      const [records] = await database.query<[Array<Record<string, unknown>>]>(
        "SELECT * FROM growth_evaluation_strategy_version WHERE organization_id = $organization_id AND status = 'active' LIMIT 1;",
        { organization_id: context.organizationId },
      );
      const active = records[0];
      if (!active) throw new Error("active strategy fixture가 없습니다");
      const stored =
        mode === "corrupt-json"
          ? { ...active, strategy_json: '{"secret":"super-secret"' }
          : {
              ...active,
              organization_id: otherContext.organizationId,
              active_guard_key: `${context.organizationId}:growth-evaluation-strategy`,
            };
      const originalQuery = database.query.bind(database);
      const query = vi.spyOn(database, "query").mockImplementation(async (sql, parameters) => {
        if (typeof sql === "string" && sql.includes("active_guard_key")) return [[stored]] as never;
        return await originalQuery(sql, parameters);
      });

      const failure = await store.getActiveStrategy(context).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(GrowthEvaluationIntegrityError);
      expect(String(failure)).not.toContain("super-secret");
      expect(
        query.mock.calls.some(
          ([sql, parameters]) =>
            typeof sql === "string" &&
            sql.includes("organization_id = $organization_id AND active_guard_key = $guard") &&
            (parameters as Record<string, unknown> | undefined)?.organization_id === context.organizationId &&
            (parameters as Record<string, unknown> | undefined)?.guard ===
              `${context.organizationId}:growth-evaluation-strategy`,
        ),
      ).toBe(true);
    },
  );

  it("strategy command replay는 stored JSON 손상을 command collision보다 먼저 typed error로 거부한다", async () => {
    const active = await store.getActiveStrategy(context);
    const input = {
      commandId: "strategy-corrupt-replay",
      expectedVersion: active.version,
      governanceDecisionId: "decision-corrupt-replay",
      strategy: { ...active.strategy, strategyId: "massion.growth.corrupt-replay" },
    };
    await createRawStrategy({
      strategyVersionId: "strategy-corrupt-replay",
      strategyJson: '{"secret":"super-secret"',
      checksum: "a".repeat(64),
      commandId: input.commandId,
      requestHash: growthChecksum(input),
    });

    const failure = await store.activateStrategy(context, input).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GrowthEvaluationIntegrityError);
    expect(String(failure)).not.toContain("super-secret");
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

  it("signal command replay는 stored request hash 손상을 command collision보다 먼저 typed error로 거부한다", async () => {
    const input = { ...required("lineage"), commandId: "signal-corrupt-replay" };
    await createRawReceipt(input, { requestHash: "f".repeat(64) });

    const failure = await store.recordSignal(context, { ...input, score: 0.5 }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GrowthEvaluationIntegrityError);
    expect(String(failure)).not.toContain("f".repeat(64));
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

  it("evaluation input hash는 receipt 순서와 무관하고 strategy 정본에는 종속된다", () => {
    const common = { strategyVersionId: "strategy-1", strategyChecksum: "a".repeat(64) };
    const forward = growthEvaluationInputHash({ ...common, receiptRequestHashes: ["b", "a"] });

    expect(growthEvaluationInputHash({ ...common, receiptRequestHashes: ["a", "b"] })).toBe(forward);
    expect(
      growthEvaluationInputHash({ ...common, strategyVersionId: "strategy-2", receiptRequestHashes: ["a", "b"] }),
    ).not.toBe(forward);
    expect(
      growthEvaluationInputHash({ ...common, strategyChecksum: "c".repeat(64), receiptRequestHashes: ["a", "b"] }),
    ).not.toBe(forward);
  });

  it("빈·중복·missing·foreign tenant·foreign suggestion receipt는 저장 전에 거부한다", async () => {
    const suggestionId = "suggestion-boundary";
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, "boundary").map(async (input) => await store.recordSignal(context, input)),
    );
    const foreignSuggestion = await store.recordSignal(context, {
      ...supporting(),
      commandId: "boundary-foreign-suggestion",
      suggestionId: "suggestion-foreign",
    });
    const foreignTenant = await store.recordSignal(otherContext, {
      ...supporting(),
      commandId: "boundary-foreign-tenant",
      suggestionId,
    });
    const ids = receipts.map((receipt) => receipt.receiptId);
    const firstId = ids[0];
    if (!firstId) throw new Error("receipt fixture가 없습니다");
    const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["empty", []],
      ["duplicate", [...ids, firstId]],
      ["missing", [...ids.slice(0, -1), "receipt-missing"]],
      ["foreign-tenant", [...ids.slice(0, -1), foreignTenant.receiptId]],
      ["foreign-suggestion", [...ids.slice(0, -1), foreignSuggestion.receiptId]],
    ] as const;

    for (const [name, receiptIds] of cases) {
      await expect(
        store.evaluate(context, { commandId: `boundary-${name}`, suggestionId, receiptIds }),
      ).rejects.toThrow(/receipt/u);
    }
    const [runs] = await database.query<[Array<{ command_id: string }>]>(
      "SELECT command_id FROM growth_evaluation_run WHERE organization_id = $organization_id AND suggestion_id = $suggestion_id;",
      { organization_id: context.organizationId, suggestion_id: suggestionId },
    );
    expect(runs).toEqual([]);
  });

  it.each(["missing-required", "duplicate-supporting"] as const)(
    "%s signal identity는 evaluation을 만들지 않는다",
    async (mode) => {
      const suggestionId = `suggestion-${mode}`;
      const inputs =
        mode === "missing-required"
          ? eligibleInputs(suggestionId, mode).filter((input) => input.signalId !== "candidate")
          : [
              ...eligibleInputs(suggestionId, mode),
              {
                ...supporting(),
                suggestionId,
                commandId: `${mode}-duplicate`,
                adapterId: "adapter-support-duplicate",
              },
            ];
      const receipts = await Promise.all(inputs.map(async (input) => await store.recordSignal(context, input)));

      await expect(
        store.evaluate(context, {
          commandId: `${mode}-evaluation`,
          suggestionId,
          receiptIds: receipts.map((receipt) => receipt.receiptId),
        }),
      ).rejects.toThrow(/signal|receipt/u);
    },
  );

  it("evaluation 생성은 receipt payload에서 canonical request hash를 다시 검증한다", async () => {
    const suggestionId = "suggestion-create-receipt-hash";
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, "create-receipt-hash").map(
        async (input) =>
          await createRawReceipt(input, input.signalId === "candidate" ? { stored: { score: 0.5 } } : {}),
      ),
    );

    await expect(
      store.evaluate(context, {
        commandId: "create-receipt-hash-evaluation",
        suggestionId,
        receiptIds: receipts.map((receipt) => receipt.receiptId),
      }),
    ).rejects.toBeInstanceOf(GrowthEvaluationIntegrityError);
    const [runs] = await database.query<[unknown[]]>(
      "SELECT * FROM growth_evaluation_run WHERE organization_id = $organization_id AND suggestion_id = $suggestion_id;",
      { organization_id: context.organizationId, suggestion_id: suggestionId },
    );
    expect(runs).toEqual([]);
  });

  it("저장된 evaluation input hash를 strategy checksum과 전체 receipt로 다시 계산한다", async () => {
    const receipts = await Promise.all(
      eligibleInputs("suggestion-corrupt-hash", "integrity-hash").map(
        async (input) => await store.recordSignal(context, input),
      ),
    );
    const evaluation = await store.evaluate(context, {
      commandId: "integrity-hash-evaluation",
      suggestionId: "suggestion-corrupt-hash",
      receiptIds: receipts.map((receipt) => receipt.receiptId),
    });
    await createRawEvaluation({
      evaluationRunId: "evaluation-corrupt-hash",
      suggestionId: evaluation.suggestionId,
      strategyVersionId: evaluation.strategyVersionId,
      receiptIds: evaluation.receiptIds,
      inputHash: "f".repeat(64),
      outcome: "eligible",
    });

    await expect(store.getForSuggestion(context, evaluation.suggestionId)).rejects.toThrow("input hash");
  });

  it.each(["missing", "duplicate"] as const)("evaluation receipt ID %s를 허용하지 않는다", async (mode) => {
    const suggestionId = `suggestion-receipt-set-${mode}`;
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, `receipt-set-${mode}`).map(
        async (input) => await store.recordSignal(context, input),
      ),
    );
    const active = await store.getActiveStrategy(context);
    const receiptIds = receipts.map((receipt) => receipt.receiptId);
    const firstReceiptId = receiptIds[0];
    if (!firstReceiptId) throw new Error("receipt fixture가 없습니다");
    await createRawEvaluation({
      evaluationRunId: `evaluation-receipt-set-${mode}`,
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds: mode === "missing" ? [...receiptIds, "receipt-missing"] : [...receiptIds, firstReceiptId],
      inputHash: "f".repeat(64),
      outcome: "eligible",
    });

    await expect(store.getForSuggestion(context, suggestionId)).rejects.toThrow("receipt 집합");
  });

  it("blocked evaluation도 required receipt를 정확히 하나씩 요구한다", async () => {
    const suggestionId = "suggestion-missing-required";
    const support = await store.recordSignal(context, {
      ...supporting(),
      suggestionId,
      commandId: "integrity-support-only",
    });
    const active = await store.getActiveStrategy(context);
    await createRawEvaluation({
      evaluationRunId: "evaluation-missing-required",
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds: [support.receiptId],
      inputHash: growthEvaluationInputHash({
        strategyVersionId: active.strategyVersionId,
        strategyChecksum: active.checksum,
        receiptRequestHashes: [support.requestHash],
      }),
      outcome: "blocked",
    });

    await expect(store.getForSuggestion(context, suggestionId)).rejects.toThrow("required receipt");
  });

  it("독립 supporting signal identity 중복을 read-time에도 거부한다", async () => {
    const suggestionId = "suggestion-duplicate-support-read";
    const inputs = [
      ...eligibleInputs(suggestionId, "duplicate-support-read"),
      {
        ...supporting(),
        suggestionId,
        commandId: "duplicate-support-read-extra",
        adapterId: "adapter-support-read-extra",
      },
    ];
    const receipts = await Promise.all(inputs.map(async (input) => await store.recordSignal(context, input)));
    const active = await store.getActiveStrategy(context);
    await createRawEvaluation({
      evaluationRunId: "evaluation-duplicate-support-read",
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds: receipts.map((receipt) => receipt.receiptId),
      inputHash: growthEvaluationInputHash({
        strategyVersionId: active.strategyVersionId,
        strategyChecksum: active.checksum,
        receiptRequestHashes: receipts.map((receipt) => receipt.requestHash),
      }),
      outcome: "eligible",
    });

    await expect(store.getForSuggestion(context, suggestionId)).rejects.toThrow("signal identity");
  });

  it.each([
    ["group", "candidate", { group: "supporting" }, "blocked"],
    ["origin", "support-independent", { origin: "model-self" }, "blocked"],
    ["outcome", "candidate", { outcome: "failed" }, "blocked"],
    ["fresh", "candidate", { fresh: false }, "blocked"],
    ["unit", "candidate", { unit: "meters" }, "blocked"],
    ["score", "candidate", { score: 0.5 }, "eligible"],
    ["evidence", "candidate", { evidence: { result: "forged", token: "super-secret" } }, "eligible"],
  ] as const)("receipt %s 변조를 request hash 불일치로 탐지한다", async (name, signalId, mutation, outcome) => {
    const suggestionId = `suggestion-tampered-${name}`;
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, `tampered-${name}`).map(
        async (input) =>
          await createRawReceipt(
            input,
            input.signalId === signalId ? { stored: mutation as Partial<GrowthSignalReceiptInput> } : {},
          ),
      ),
    );
    const active = await store.getActiveStrategy(context);
    await createRawEvaluation({
      evaluationRunId: `evaluation-tampered-${name}`,
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds: receipts.map((receipt) => receipt.receiptId),
      inputHash: growthEvaluationInputHash({
        strategyVersionId: active.strategyVersionId,
        strategyChecksum: active.checksum,
        receiptRequestHashes: receipts.map((receipt) => receipt.requestHash),
      }),
      outcome,
    });

    await expect(store.getForSuggestion(context, suggestionId)).rejects.toThrow("request hash");
  });

  it.each([
    ["malformed", '{"token":"super-secret"'],
    ["wrong-shape", '"super-secret"'],
  ] as const)("receipt evidence %s JSON은 민감 값을 노출하지 않고 fail-closed한다", async (name, evidenceJson) => {
    const suggestionId = `suggestion-evidence-${name}`;
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, `evidence-${name}`).map(
        async (input) => await createRawReceipt(input, input.signalId === "candidate" ? { evidenceJson } : {}),
      ),
    );
    const active = await store.getActiveStrategy(context);
    await createRawEvaluation({
      evaluationRunId: `evaluation-evidence-${name}`,
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds: receipts.map((receipt) => receipt.receiptId),
      inputHash: growthEvaluationInputHash({
        strategyVersionId: active.strategyVersionId,
        strategyChecksum: active.checksum,
        receiptRequestHashes: receipts.map((receipt) => receipt.requestHash),
      }),
      outcome: "eligible",
    });

    const failure = await store.getForSuggestion(context, suggestionId).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GrowthEvaluationIntegrityError);
    expect(String(failure)).not.toContain("super-secret");
  });

  it.each([
    ["malformed", '{"strategyId":"super-secret"', "a".repeat(64)],
    ["wrong-shape", '{"strategyId":"super-secret"}', growthChecksum({ strategyId: "super-secret" })],
    ["checksum", canonicalGrowthJson({ strategyId: "super-secret" }), "b".repeat(64)],
  ] as const)("strategy %s 손상은 민감 값을 노출하지 않고 fail-closed한다", async (name, strategyJson, checksum) => {
    const suggestionId = `suggestion-strategy-${name}`;
    const strategyVersionId = `strategy-corrupt-${name}`;
    await createRawStrategy({ strategyVersionId, strategyJson, checksum });
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, `strategy-${name}`).map(async (input) => await createRawReceipt(input)),
    );
    await createRawEvaluation({
      evaluationRunId: `evaluation-strategy-${name}`,
      suggestionId,
      strategyVersionId,
      receiptIds: receipts.map((receipt) => receipt.receiptId),
      inputHash: growthEvaluationInputHash({
        strategyVersionId,
        strategyChecksum: checksum,
        receiptRequestHashes: receipts.map((receipt) => receipt.requestHash),
      }),
      outcome: "eligible",
    });

    const failure = await store.getForSuggestion(context, suggestionId).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GrowthEvaluationIntegrityError);
    expect(String(failure)).not.toContain("super-secret");
  });

  it("다른 tenant의 strategy는 존재해도 현재 evaluation 계보로 사용하지 않는다", async () => {
    const otherStrategy = await store.bootstrap(otherContext);
    const suggestionId = "suggestion-foreign-strategy";
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, "foreign-strategy").map(async (input) => await store.recordSignal(context, input)),
    );
    await createRawEvaluation({
      evaluationRunId: "evaluation-foreign-strategy",
      suggestionId,
      strategyVersionId: otherStrategy.strategyVersionId,
      receiptIds: receipts.map((receipt) => receipt.receiptId),
      inputHash: growthEvaluationInputHash({
        strategyVersionId: otherStrategy.strategyVersionId,
        strategyChecksum: otherStrategy.checksum,
        receiptRequestHashes: receipts.map((receipt) => receipt.requestHash),
      }),
      outcome: "eligible",
    });

    await expect(store.getForSuggestion(context, suggestionId)).rejects.toThrow("strategy 계보");
  });

  it.each([
    ["eligible", "blocked"],
    ["blocked", "eligible"],
    ["ineligible", "blocked"],
  ] as const)("stored %s outcome을 receipt로 재계산한다", async (actualOutcome, forgedOutcome) => {
    const suggestionId = `suggestion-outcome-${actualOutcome}`;
    const inputs = eligibleInputs(suggestionId, `outcome-${actualOutcome}`);
    if (actualOutcome === "blocked") {
      const candidate = inputs[2];
      if (!candidate) throw new Error("candidate fixture가 없습니다");
      inputs[2] = { ...candidate, outcome: "failed" };
    }
    if (actualOutcome === "ineligible") {
      inputs.push({
        ...required("security"),
        commandId: "outcome-ineligible-conflict",
        suggestionId,
        group: "conflict",
      });
    }
    const receipts = await Promise.all(inputs.map(async (input) => await store.recordSignal(context, input)));
    const evaluation = await store.evaluate(context, {
      commandId: `evaluation-outcome-${actualOutcome}`,
      suggestionId,
      receiptIds: receipts.map((receipt) => receipt.receiptId),
    });
    expect(evaluation.outcome).toBe(actualOutcome);
    await createRawEvaluation({
      evaluationRunId: `evaluation-outcome-forged-${actualOutcome}`,
      suggestionId,
      strategyVersionId: evaluation.strategyVersionId,
      receiptIds: evaluation.receiptIds,
      inputHash: evaluation.inputHash,
      outcome: forgedOutcome,
    });

    await expect(store.getForSuggestion(context, suggestionId)).rejects.toThrow("outcome");
  });

  it("evaluation command replay도 저장된 무결성을 다시 검증한다", async () => {
    const suggestionId = "suggestion-replay-integrity";
    const commandId = "evaluation-replay-integrity";
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, "replay-integrity").map(async (input) => await store.recordSignal(context, input)),
    );
    const active = await store.getActiveStrategy(context);
    const receiptIds = receipts.map((receipt) => receipt.receiptId);
    await createRawEvaluation({
      evaluationRunId: "evaluation-replay-corrupt",
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds,
      inputHash: "f".repeat(64),
      outcome: "eligible",
      commandId,
      requestHash: growthChecksum({ commandId, suggestionId, receiptIds }),
    });

    await expect(store.evaluate(context, { commandId, suggestionId, receiptIds })).rejects.toBeInstanceOf(
      GrowthEvaluationIntegrityError,
    );
  });

  it.each(["read", "replay"] as const)(
    "evaluation stored request hash 손상은 %s에서 input hash보다 먼저 typed error로 수렴한다",
    async (mode) => {
      const suggestionId = `suggestion-request-hash-${mode}`;
      const commandId = `evaluation-request-hash-${mode}`;
      const receipts = await Promise.all(
        eligibleInputs(suggestionId, `request-hash-${mode}`).map(
          async (input) => await store.recordSignal(context, input),
        ),
      );
      const active = await store.getActiveStrategy(context);
      const receiptIds = receipts.map((receipt) => receipt.receiptId);
      await createRawEvaluation({
        evaluationRunId: `evaluation-request-hash-${mode}`,
        suggestionId,
        strategyVersionId: active.strategyVersionId,
        receiptIds,
        inputHash: growthEvaluationInputHash({
          strategyVersionId: active.strategyVersionId,
          strategyChecksum: active.checksum,
          receiptRequestHashes: receipts.map((receipt) => receipt.requestHash),
        }),
        outcome: "eligible",
        commandId,
        requestHash: "f".repeat(64),
      });

      const failure = await (
        mode === "read"
          ? store.getForSuggestion(context, suggestionId)
          : store.evaluate(context, { commandId, suggestionId, receiptIds: [...receiptIds].reverse() })
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(GrowthEvaluationIntegrityError);
      expect(String(failure)).toContain("request hash");
      expect(String(failure)).not.toContain("f".repeat(64));
    },
  );

  it("evaluation replay는 stored receipt 손상을 incoming command collision보다 먼저 거부한다", async () => {
    const suggestionId = "suggestion-replay-receipt-corrupt";
    const commandId = "evaluation-replay-receipt-corrupt";
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, "replay-receipt-corrupt").map(
        async (input) =>
          await createRawReceipt(input, input.signalId === "candidate" ? { stored: { score: 0.5 } } : {}),
      ),
    );
    const active = await store.getActiveStrategy(context);
    const receiptIds = receipts.map((receipt) => receipt.receiptId);
    await createRawEvaluation({
      evaluationRunId: "evaluation-replay-receipt-corrupt",
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds,
      inputHash: growthEvaluationInputHash({
        strategyVersionId: active.strategyVersionId,
        strategyChecksum: active.checksum,
        receiptRequestHashes: receipts.map((receipt) => receipt.requestHash),
      }),
      outcome: "eligible",
      commandId,
    });

    const failure = await store
      .evaluate(context, { commandId, suggestionId, receiptIds: [...receiptIds].reverse() })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(GrowthEvaluationIntegrityError);
    expect(String(failure)).toContain("receipt request hash");
  });

  it("evaluation command receiptIds 순서는 order-sensitive payload 계약을 유지한다", async () => {
    const suggestionId = "suggestion-order-sensitive-command";
    const commandId = "evaluation-order-sensitive-command";
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, "order-sensitive-command").map(
        async (input) => await store.recordSignal(context, input),
      ),
    );
    const receiptIds = receipts.map((receipt) => receipt.receiptId);
    const evaluation = await store.evaluate(context, { commandId, suggestionId, receiptIds });

    await expect(store.evaluate(context, { commandId, suggestionId, receiptIds })).resolves.toEqual(evaluation);
    const failure = await store
      .evaluate(context, { commandId, suggestionId, receiptIds: [...receiptIds].reverse() })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GrowthEvaluationIntegrityError);
    expect(String(failure)).toContain("같은 commandId");
  });

  it("created_at 동률에서도 tenant 안의 최신 evaluation을 결정적으로 선택한다", async () => {
    const suggestionId = "suggestion-tied-latest";
    const receipts = await Promise.all(
      eligibleInputs(suggestionId, "tied-latest").map(async (input) => await store.recordSignal(context, input)),
    );
    const active = await store.getActiveStrategy(context);
    const receiptIds = receipts.map((receipt) => receipt.receiptId);
    const inputHash = growthEvaluationInputHash({
      strategyVersionId: active.strategyVersionId,
      strategyChecksum: active.checksum,
      receiptRequestHashes: receipts.map((receipt) => receipt.requestHash),
    });
    await createRawEvaluation({
      evaluationRunId: "evaluation-tie-b",
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds,
      inputHash,
      outcome: "eligible",
    });
    await createRawEvaluation({
      evaluationRunId: "evaluation-tie-a",
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds,
      inputHash,
      outcome: "eligible",
    });
    await createRawEvaluation({
      evaluationRunId: "evaluation-tie-z-foreign",
      organizationId: otherContext.organizationId,
      suggestionId,
      strategyVersionId: active.strategyVersionId,
      receiptIds: [],
      inputHash,
      outcome: "eligible",
    });
    const query = vi.spyOn(database, "query");

    const details = await Promise.all([
      store.getForSuggestion(context, suggestionId),
      store.getForSuggestion(context, suggestionId),
    ]);

    expect(details.map((detail) => detail?.evaluationRunId)).toEqual(["evaluation-tie-b", "evaluation-tie-b"]);
    expect(
      query.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("ORDER BY created_at DESC, evaluation_run_id DESC"),
      ),
    ).toBe(true);
  });
});
