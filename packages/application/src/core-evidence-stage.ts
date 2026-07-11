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
    const content = JSON.parse(plan.content_json) as {
      evidenceRequests?: readonly { readonly key?: unknown; readonly required?: unknown }[];
    };
    const required = (content.evidenceRequests ?? []).filter((request) => request.required === true).length;
    const request =
      input.request && typeof input.request === "object" ? (input.request as { evidenceBriefIds?: unknown }) : {};
    const ids =
      Array.isArray(request.evidenceBriefIds) && request.evidenceBriefIds.every((id) => typeof id === "string")
        ? [...new Set(request.evidenceBriefIds)]
        : [];
    if (required > 0 && ids.length < required) return { outcome: "blocked", reason: "evidence-required" };
    for (const id of ids) {
      const brief = await this.dependencies.briefs.getBrief(context, id);
      if (brief.workId !== input.workId || !["ready", "stale_warning"].includes(brief.status))
        return { outcome: "blocked", reason: "evidence-invalid" };
    }
    return { outcome: "advanced", data: { evidenceBriefIds: ids } };
  }
}
