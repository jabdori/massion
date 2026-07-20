import type { EvidenceBriefStore } from "@massion/evidence";
import type { TenantContext } from "@massion/identity";
import type { WorkService } from "@massion/work";

import type { CoreWorkStageExecutor, CoreWorkStageInput, CoreWorkStageResult } from "./core-work-coordinator.js";

export class CoreEvidenceStage implements CoreWorkStageExecutor {
  public constructor(
    private readonly dependencies: {
      readonly works: Pick<WorkService, "getActivePlan">;
      readonly briefs: Pick<EvidenceBriefStore, "getBrief">;
    },
  ) {}

  public async execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult> {
    if (!input.workId) throw new Error("Evidence stage에 Work ID가 없습니다");
    const plan = await this.dependencies.works.getActivePlan(context, input.workId);
    if (!plan) return { outcome: "blocked", reason: "strategy-plan-missing" };
    const request =
      input.request && typeof input.request === "object" ? (input.request as { evidenceBriefIds?: unknown }) : {};
    const ids =
      Array.isArray(request.evidenceBriefIds) && request.evidenceBriefIds.every((id) => typeof id === "string")
        ? [...new Set(request.evidenceBriefIds)]
        : [];
    // evidence가 명시적으로 제공되지 않았을 때 업무를 차단하지 않고 빈 evidence로 진행합니다.
    // 사용자가 evidence를 직접 수집해 제공할 때만 검증합니다.
    for (const id of ids) {
      const brief = await this.dependencies.briefs.getBrief(context, id);
      if (brief.workId !== input.workId || !["ready", "stale_warning"].includes(brief.status))
        return { outcome: "blocked", reason: "evidence-invalid" };
    }
    return { outcome: "advanced", data: { evidenceBriefIds: ids } };
  }
}
