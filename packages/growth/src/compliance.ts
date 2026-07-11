import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase } from "@massion/storage";

import { growthChecksum } from "./prompt-memory.js";

export interface GrowthLineageSnapshot {
  readonly reflectionCompleted: boolean;
  readonly configurationMatches: boolean;
  readonly runtimeSucceeded: boolean;
  readonly evaluationOutcome: "eligible" | "ineligible" | "blocked";
  readonly evaluationHashMatches: boolean;
  readonly governanceScopeMatches: boolean;
  readonly targetVersionMatches: boolean;
  readonly baselineMatches: boolean;
  readonly effectSequenceMatches: boolean;
  readonly revertSequenceMatches: boolean;
}

export function assertGrowthLineageCompliant(snapshot: GrowthLineageSnapshot): void {
  if (
    !snapshot.reflectionCompleted ||
    !snapshot.configurationMatches ||
    !snapshot.runtimeSucceeded ||
    snapshot.evaluationOutcome !== "eligible" ||
    !snapshot.evaluationHashMatches ||
    !snapshot.governanceScopeMatches ||
    !snapshot.targetVersionMatches ||
    !snapshot.baselineMatches ||
    !snapshot.effectSequenceMatches ||
    !snapshot.revertSequenceMatches
  ) {
    throw new Error("Growth 준수 계보가 불완전하거나 변조됐습니다");
  }
}

interface AdoptionAuditRecord {
  readonly adoption_id: string;
  readonly suggestion_id: string;
  readonly target_kind: "prompt" | "memory" | "policy" | "organization";
  readonly configuration_version_id: string;
  readonly evaluation_run_id: string;
  readonly evaluation_input_hash: string;
  readonly runtime_execution_id: string;
  readonly after_version_id?: string;
  readonly after_checksum?: string;
  readonly governance_decision_id?: string;
  readonly status: string;
}

export class GrowthComplianceAuditor {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async assertDatabaseCompliant(context: TenantContext): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    const [adoptions] = await this.database.query<[AdoptionAuditRecord[]]>(
      "SELECT * FROM growth_adoption_run WHERE organization_id = $organization_id AND status IN ['observing', 'reverted'];",
      { organization_id: context.organizationId },
    );
    for (const adoption of adoptions)
      assertGrowthLineageCompliant(await this.snapshot(context.organizationId, adoption));
  }

  private async snapshot(org: string, adoption: AdoptionAuditRecord): Promise<GrowthLineageSnapshot> {
    const [suggestions] = await this.database.query<[Array<{ reflection_run_id: string }>]>(
      "SELECT reflection_run_id FROM growth_suggestion WHERE organization_id = $organization_id AND suggestion_id = $suggestion_id LIMIT 1;",
      { organization_id: org, suggestion_id: adoption.suggestion_id },
    );
    const [reflections] = suggestions[0]
      ? await this.database.query<[Array<{ status: string; runtime_execution_id?: string }>]>(
          "SELECT status, runtime_execution_id FROM reflection_run WHERE organization_id = $organization_id AND reflection_run_id = $reflection_run_id LIMIT 1;",
          { organization_id: org, reflection_run_id: suggestions[0].reflection_run_id },
        )
      : [[]];
    const [runtime] = await this.database.query<[Array<{ status: string; agent_handle: string }>]>(
      "SELECT status, agent_handle FROM runtime_execution WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
      { organization_id: org, execution_id: adoption.runtime_execution_id },
    );
    const [configurations] = await this.database.query<[Array<{ checksum: string; status: string }>]>(
      "SELECT checksum, status FROM growth_configuration_version WHERE organization_id = $organization_id AND configuration_version_id = $configuration_version_id LIMIT 1;",
      { organization_id: org, configuration_version_id: adoption.configuration_version_id },
    );
    const [evaluations] = await this.database.query<
      [Array<{ outcome: "eligible" | "ineligible" | "blocked"; input_hash: string; suggestion_id: string }>]
    >(
      "SELECT outcome, input_hash, suggestion_id FROM growth_evaluation_run WHERE organization_id = $organization_id AND evaluation_run_id = $evaluation_run_id LIMIT 1;",
      { organization_id: org, evaluation_run_id: adoption.evaluation_run_id },
    );
    const [decisions] = await this.database.query<[Array<{ action: string; resource_id: string }>]>(
      "SELECT action, resource_id FROM governance_policy_decision WHERE organization_id = $organization_id AND decision_id = $decision_id LIMIT 1;",
      { organization_id: org, decision_id: adoption.governance_decision_id },
    );
    const [baselines] = await this.database.query<[Array<{ target_version_id: string }>]>(
      "SELECT target_version_id FROM growth_effect_baseline WHERE organization_id = $organization_id AND adoption_id = $adoption_id LIMIT 1;",
      { organization_id: org, adoption_id: adoption.adoption_id },
    );
    const [effects] = await this.database.query<[Array<{ result: string }>]>(
      "SELECT result FROM growth_effect_evaluation WHERE organization_id = $organization_id AND adoption_id = $adoption_id;",
      { organization_id: org, adoption_id: adoption.adoption_id },
    );
    const [reverts] =
      adoption.status === "reverted"
        ? await this.database.query<[Array<{ status: string; mode: string }>]>(
            "SELECT status, mode FROM growth_revert_operation WHERE organization_id = $organization_id AND adoption_id = $adoption_id LIMIT 1;",
            { organization_id: org, adoption_id: adoption.adoption_id },
          )
        : [[]];
    const evaluation = evaluations[0];
    const reflection = reflections[0];
    const configuration = configurations[0];
    const runtimeExecution = runtime[0];
    const decision = decisions[0];
    const targetVersionMatches = await this.targetMatches(org, adoption);
    return {
      reflectionCompleted: Boolean(
        reflection &&
        reflection.status === "completed" &&
        reflection.runtime_execution_id === adoption.runtime_execution_id,
      ),
      configurationMatches:
        Boolean(configuration?.checksum) && ["active", "superseded"].includes(configuration?.status ?? ""),
      runtimeSucceeded: Boolean(
        runtimeExecution && runtimeExecution.status === "succeeded" && runtimeExecution.agent_handle === "growth",
      ),
      evaluationOutcome: evaluation?.outcome ?? "blocked",
      evaluationHashMatches: Boolean(
        evaluation &&
        evaluation.input_hash === adoption.evaluation_input_hash &&
        evaluation.suggestion_id === adoption.suggestion_id,
      ),
      governanceScopeMatches: Boolean(
        decision && decision.action === "growth.adopt" && decision.resource_id === adoption.suggestion_id,
      ),
      targetVersionMatches,
      baselineMatches: baselines[0]?.target_version_id === adoption.after_version_id,
      effectSequenceMatches: adoption.status === "observing" || effects.length > 0 || reverts[0]?.mode === "explicit",
      revertSequenceMatches: adoption.status !== "reverted" || reverts[0]?.status === "completed",
    };
  }

  private async targetMatches(org: string, adoption: AdoptionAuditRecord): Promise<boolean> {
    if (!adoption.after_version_id || !adoption.after_checksum) return false;
    if (adoption.target_kind === "prompt") {
      const [rows] = await this.database.query<[Array<{ checksum: string }>]>(
        "SELECT checksum FROM prompt_definition_version WHERE organization_id = $organization_id AND prompt_definition_version_id = $version_id LIMIT 1;",
        { organization_id: org, version_id: adoption.after_version_id },
      );
      return rows[0]?.checksum === adoption.after_checksum;
    }
    if (adoption.target_kind === "memory") {
      const [rows] = await this.database.query<[Array<{ checksum: string }>]>(
        "SELECT checksum FROM memory_version WHERE organization_id = $organization_id AND memory_version_id = $version_id LIMIT 1;",
        { organization_id: org, version_id: adoption.after_version_id },
      );
      return rows[0]?.checksum === adoption.after_checksum;
    }
    if (adoption.target_kind === "policy") {
      const [rows] = await this.database.query<[Array<{ checksum: string }>]>(
        "SELECT checksum FROM governance_policy_version WHERE organization_id = $organization_id AND policy_version_id = $version_id LIMIT 1;",
        { organization_id: org, version_id: adoption.after_version_id },
      );
      return rows[0]?.checksum === adoption.after_checksum;
    }
    const [rows] = await this.database.query<[Array<{ version_id: string; after_json: string }>]>(
      "SELECT version_id, after_json FROM organization_version WHERE organization_id = $organization_id AND version_id = $version_id LIMIT 1;",
      { organization_id: org, version_id: adoption.after_version_id },
    );
    if (!rows[0]) return false;
    return (
      growthChecksum({ versionId: rows[0].version_id, nodes: JSON.parse(rows[0].after_json) as unknown }) ===
      adoption.after_checksum
    );
  }
}
