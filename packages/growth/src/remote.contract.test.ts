import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { applyMigrations, createDatabase } from "@massion/storage";

import { GrowthAdoptionService } from "./adoption.js";
import { GrowthComplianceAuditor } from "./compliance.js";
import { GrowthConfigurationStore } from "./configuration.js";
import { GrowthEffectStore, type GrowthEffectSample } from "./effect.js";
import { GrowthEvaluationStore } from "./evaluation.js";
import { GrowthMetricStore } from "./metrics.js";
import { PromptMemoryStore } from "./prompt-memory.js";
import { GrowthRevertService } from "./revert.js";
import { GROWTH_ADOPTION_MIGRATION, GROWTH_PROMPT_MEMORY_MIGRATION } from "./schema.js";
import { GrowthTargetRegistry, PromptGrowthTarget } from "./targets.js";
import { GrowthTriggerStore } from "./trigger.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("remote Growth contract", () => {
  remoteTest("SurrealDB 3.2.x에서 권한·migration·metric 경쟁 계약을 지킨다", async () => {
    const databaseName = `growth_${crypto.randomUUID().replaceAll("-", "")}`;
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
    expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: `growth-${databaseName}@example.com`,
      displayName: "Growth Remote",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    await applyMigrations(database, [GROWTH_PROMPT_MEMORY_MIGRATION, GROWTH_ADOPTION_MIGRATION]);
    const metrics = await GrowthMetricStore.create(database, organizations);
    const metric = {
      name: "growth_recovery_total",
      value: 1,
      unit: "count",
      dimensions: { stage: "adoption", result: "recovered" },
    } as const;
    const concurrent = await Promise.allSettled([
      metrics.recordOnce(context, "remote-concurrent", metric),
      metrics.recordOnce(context, "remote-concurrent", {
        ...metric,
        dimensions: { stage: "revert", result: "recovered" },
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [stored] = await database.query<[unknown[]]>(
      "SELECT * FROM growth_metric WHERE organization_id = $organization_id AND idempotency_key = 'remote-concurrent';",
      { organization_id: context.organizationId },
    );
    expect(stored).toHaveLength(1);

    const configurations = await GrowthConfigurationStore.create(database, organizations, {
      authorizeConfiguration: async (_context, input) => ({ governanceDecisionId: `decision:${input.commandId}` }),
    });
    const review = await configurations.resolve(context);
    expect(review.adoptionMode).toBe("review");
    const auto = await configurations.configure(context, {
      commandId: "remote-auto",
      subject: { type: "organization" },
      reflectionEnabled: true,
      adoptionMode: "auto",
      expectedVersion: 1,
    });
    const graph = await OrganizationGraphService.create(database, organizations);
    const organization = await graph.bootstrap(context);
    const prompts = await PromptMemoryStore.create(database, organizations);
    await prompts.bootstrap(context, organization.nodes);
    const evaluations = await GrowthEvaluationStore.create(database, organizations);
    await evaluations.bootstrap(context);
    await database.query(
      "DEFINE TABLE records_run SCHEMALESS; DEFINE TABLE work_record SCHEMALESS; DEFINE TABLE work SCHEMALESS; DEFINE TABLE work_request SCHEMALESS; DEFINE TABLE runtime_execution SCHEMALESS;",
    );
    await database.query(
      "CREATE records_run CONTENT { organization_id: $organization_id, work_id: 'remote-work', records_run_id: 'remote-records', verification_id: 'remote-verification', assurance_run_id: 'remote-assurance', status: 'completed' }; CREATE work_record CONTENT { organization_id: $organization_id, work_id: 'remote-work', records_run_id: 'remote-records', work_record_id: 'remote-work-record', finalized: true, schema_version: 'massion.work-record.v1' }; CREATE work_request CONTENT { organization_id: $organization_id, request_id: 'remote-request', requester_user_id: $user_id }; CREATE work CONTENT { organization_id: $organization_id, work_id: 'remote-work', request_id: 'remote-request', status: 'completed' };",
      { organization_id: context.organizationId, user_id: context.userId },
    );
    const triggers = await GrowthTriggerStore.create(database, organizations, configurations);
    await expect(triggers.backfill(context)).resolves.toEqual({ created: 1, existing: 0 });
    await expect(triggers.backfill(context)).resolves.toEqual({ created: 0, existing: 1 });

    const promptTarget = new PromptGrowthTarget(prompts);
    const registry = new GrowthTargetRegistry({
      prompt: promptTarget,
      memory: promptTarget,
      policy: promptTarget,
      organization: promptTarget,
    });
    const before = await database.transaction(
      async (executor) =>
        await promptTarget.inspect(context, { suggestionId: "remote-suggestion-a", patch: {} }, executor),
    );
    const section = (before.snapshot.sections as Array<{ agentHandle: string }>)[0];
    if (!section) throw new Error("원격 Prompt section이 없습니다");
    await database.query(
      "CREATE runtime_execution CONTENT { organization_id: $organization_id, work_id: 'remote-work', execution_id: 'remote-growth-runtime', agent_handle: 'growth', status: 'succeeded' };",
      { organization_id: context.organizationId },
    );
    for (const suffix of ["a", "b"]) {
      await database.query(
        "CREATE reflection_run CONTENT { reflection_run_id: $reflection_id, organization_id: $organization_id, work_id: 'remote-work', records_run_id: 'remote-records', trigger_id: $trigger_id, configuration_version_id: $configuration_version_id, runtime_execution_id: 'remote-growth-runtime', snapshot_hash: $hash, status: 'completed', version: 2, attempt: 1, command_id: $reflection_command, request_hash: $hash, created_at: time::now(), updated_at: time::now() }; CREATE growth_suggestion CONTENT { suggestion_id: $suggestion_id, organization_id: $organization_id, work_id: 'remote-work', reflection_run_id: $reflection_id, target_kind: 'prompt', operation: 'replace-instruction', patch_json: $patch, summary: 'remote improvement', rationale: 'remote evidence', expected_effect: 'higher assurance', risk_summary: 'bounded', source_reference_ids: ['remote-source'], status: 'evaluated', created_at: time::now() }; CREATE growth_evaluation_run CONTENT { evaluation_run_id: $evaluation_id, organization_id: $organization_id, suggestion_id: $suggestion_id, strategy_version_id: $strategy_version_id, receipt_ids: [], input_hash: $hash, outcome: 'eligible', reason_json: '{}', command_id: $evaluation_command, request_hash: $hash, created_at: time::now() };",
        {
          organization_id: context.organizationId,
          configuration_version_id: auto.configurationVersionId,
          reflection_id: `remote-reflection-${suffix}`,
          trigger_id: `remote-trigger-${suffix}`,
          reflection_command: `remote-reflection-command-${suffix}`,
          suggestion_id: `remote-suggestion-${suffix}`,
          evaluation_id: `remote-evaluation-${suffix}`,
          evaluation_command: `remote-evaluation-command-${suffix}`,
          strategy_version_id: (await evaluations.getActiveStrategy(context)).strategyVersionId,
          hash: "e".repeat(64),
          patch: JSON.stringify({ agentHandle: section.agentHandle, instruction: `원격 개선 ${suffix}` }),
        },
      );
    }
    const adoptions = await GrowthAdoptionService.create(
      database,
      organizations,
      {
        authorizeAdoption: async (_context, input) => ({
          outcome: "allow",
          decision: {
            decisionId: `decision-${input.suggestionId}`,
            organizationId: context.organizationId,
            requestHash: "d".repeat(64),
            outcome: "allow",
            reasons: [],
            errors: [],
            automationMode: "auto",
            createdAt: new Date(),
          },
        }),
      },
      registry,
    );
    const concurrentAdoption = await Promise.allSettled(
      ["a", "b"].map(
        async (suffix) =>
          await adoptions.adopt(context, {
            commandId: `remote-adopt-${suffix}`,
            suggestionId: `remote-suggestion-${suffix}`,
            suggestionRevision: 1,
            evaluationRunId: `remote-evaluation-${suffix}`,
            expectedEvaluationInputHash: "e".repeat(64),
            expectedTargetChecksum: before.checksum,
          }),
      ),
    );
    expect(concurrentAdoption.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const adopted = concurrentAdoption.find((result) => result.status === "fulfilled");
    if (!adopted || adopted.status !== "fulfilled" || !adopted.value.afterVersionId)
      throw new Error("원격 Adoption 결과가 없습니다");
    const effect = await GrowthEffectStore.create(database, organizations);
    const contract: GrowthEffectSample["contract"] = {
      strategyVersionId: "remote-strategy",
      caseSetChecksum: "remote-case",
      metricSourceId: "assurance",
      metricSourceVersion: "1.0.0",
      unit: "ratio",
      windowChecksum: "remote-window",
      direction: "higher",
      stableTolerance: 0.02,
      degradationThreshold: 0.1,
      minimumObservations: 5,
    };
    await effect.captureBaseline(context, {
      commandId: "remote-baseline",
      adoptionId: adopted.value.adoption.adoption_id,
      sample: { score: 0.8, observationCount: 10, contract },
    });
    await expect(
      effect.observe(context, {
        commandId: "remote-observation",
        adoptionId: adopted.value.adoption.adoption_id,
        sample: { score: 0.4, observationCount: 10, contract },
      }),
    ).resolves.toMatchObject({ result: "degraded" });
    const reverts = await GrowthRevertService.create(
      database,
      organizations,
      {
        authorizeRevert: async () => ({
          outcome: "allow",
          decision: {
            decisionId: "decision-remote-revert",
            organizationId: context.organizationId,
            requestHash: "r".repeat(64),
            outcome: "allow",
            reasons: [],
            errors: [],
            automationMode: "auto",
            createdAt: new Date(),
          },
        }),
      },
      registry,
    );
    await expect(
      reverts.revert(context, {
        commandId: "remote-revert",
        adoptionId: adopted.value.adoption.adoption_id,
        suggestionRevision: 1,
        reason: "degraded",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect((await prompts.getActivePromptDefinition(context)).sections).toEqual(before.snapshot.sections);

    await database.query(
      "DEFINE TABLE governance_policy_decision SCHEMALESS; CREATE governance_policy_decision CONTENT { organization_id: $organization_id, decision_id: $decision_id, action: 'growth.adopt', resource_id: $suggestion_id };",
      {
        organization_id: context.organizationId,
        decision_id: adopted.value.adoption.governance_decision_id,
        suggestion_id: adopted.value.adoption.suggestion_id,
      },
    );
    const auditor = new GrowthComplianceAuditor(database, organizations);
    await expect(auditor.assertDatabaseCompliant(context)).resolves.toBeUndefined();
    await database.query(
      "REMOVE EVENT growth_evaluation_run_immutable ON TABLE growth_evaluation_run; UPDATE growth_evaluation_run SET input_hash = $hash WHERE organization_id = $organization_id AND evaluation_run_id = $evaluation_id;",
      {
        organization_id: context.organizationId,
        evaluation_id: adopted.value.adoption.evaluation_run_id,
        hash: "f".repeat(64),
      },
    );
    await expect(auditor.assertDatabaseCompliant(context)).rejects.toThrow("Growth 준수");

    await database.query(`
      DEFINE TABLE growth_security_user SCHEMAFULL PERMISSIONS FOR create FULL, FOR select WHERE id = $auth.id;
      DEFINE FIELD email ON growth_security_user TYPE string;
      DEFINE FIELD pass ON growth_security_user TYPE string;
      DEFINE ACCESS growth_record ON DATABASE TYPE RECORD
        SIGNUP (CREATE growth_security_user SET email = $email, pass = crypto::argon2::generate($pass))
        SIGNIN (SELECT * FROM growth_security_user WHERE email = $email AND crypto::argon2::compare(pass, $pass));
    `);
    const httpBase = (remoteUrl ?? "")
      .replace(/^ws:/u, "http:")
      .replace(/^wss:/u, "https:")
      .replace(/\/rpc$/u, "");
    const signup = await fetch(`${httpBase}/signup`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        ns: "massion",
        db: databaseName,
        ac: "growth_record",
        email: "record@example.com",
        pass: "safe-pass-123",
      }),
    });
    const body = (await signup.json()) as { readonly token?: unknown };
    if (typeof body.token !== "string") throw new Error(`record user token이 없습니다: ${JSON.stringify(body)}`);
    for (const statement of [
      "CREATE growth_adoption_run SET adoption_id = 'forged';",
      "CREATE prompt_definition_version SET prompt_definition_version_id = 'forged';",
      "CREATE memory_version SET memory_version_id = 'forged';",
    ]) {
      const response = await fetch(`${httpBase}/sql`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${body.token}`,
          "content-type": "text/plain",
          "surreal-ns": "massion",
          "surreal-db": databaseName,
        },
        body: statement,
      });
      expect(response.ok).toBe(true);
    }
    const [info] = await database.query<[{ tables: Record<string, string> }]>("INFO FOR DB;");
    for (const table of ["growth_adoption_run", "prompt_definition_version", "memory_version", "growth_metric"])
      expect(info.tables[table]).toContain("PERMISSIONS NONE");
  });
});
