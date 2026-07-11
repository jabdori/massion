import type { TenantContext } from "@massion/identity";
import type { OrganizationGraphService } from "@massion/organization";

import type { GrowthComplianceAuditor } from "./compliance.js";
import type { GrowthEvaluationStore } from "./evaluation.js";
import type { PromptMemoryStore } from "./prompt-memory.js";
import type { GrowthRecoveryService } from "./recovery.js";

export function decideGrowthBootstrap(input: {
  readonly fresh: boolean;
  readonly compliant: boolean;
}): "initialize" | "activate" {
  if (!input.compliant) throw new Error("Growth 준수 위반 database는 gateway를 활성화할 수 없습니다");
  return input.fresh ? "initialize" : "activate";
}

export class GrowthBootstrap {
  public constructor(
    private readonly graph: OrganizationGraphService,
    private readonly prompts: PromptMemoryStore,
    private readonly evaluations: GrowthEvaluationStore,
    private readonly compliance: GrowthComplianceAuditor,
    private readonly recovery?: GrowthRecoveryService,
  ) {}

  public async start(context: TenantContext): Promise<{ readonly action: "initialize" | "activate" }> {
    await this.compliance.assertDatabaseCompliant(context);
    const existing = await this.graph.listNodes(context);
    const action = decideGrowthBootstrap({ fresh: existing.length === 0, compliant: true });
    const graph = await this.graph.bootstrap(context);
    await this.prompts.bootstrap(context, graph.nodes);
    await this.evaluations.bootstrap(context);
    if (this.recovery) await this.recovery.scan(context);
    return { action };
  }
}
