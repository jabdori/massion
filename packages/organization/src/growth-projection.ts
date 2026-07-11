import type { TenantContext } from "@massion/identity";
import type { QueryExecutor } from "@massion/storage";

import { verifyGrowthProjectionDecision, type GrowthProjectionAuthorization } from "@massion/governance";
import { CORE_OFFICE_HANDLES, type GraphChangeResult, type OrganizationGraphService } from "./organization.js";

export interface GrowthOrganizationPatch extends Readonly<Record<string, unknown>> {
  readonly handle: string;
  readonly responsibility: string;
}

export function assertGrowthOrganizationPatch(
  patch: Readonly<Record<string, unknown>>,
): asserts patch is GrowthOrganizationPatch {
  if (
    Object.keys(patch).sort().join(",") !== "handle,responsibility" ||
    typeof patch.handle !== "string" ||
    typeof patch.responsibility !== "string" ||
    !patch.handle.trim() ||
    !patch.responsibility.trim()
  )
    throw new Error("Organization Growth patch schema가 유효하지 않습니다");
  if ((CORE_OFFICE_HANDLES as readonly string[]).includes(patch.handle))
    throw new Error("Core Office 노드는 Growth로 변경할 수 없습니다");
}

export class OrganizationGrowthProjection {
  public constructor(private readonly graph: OrganizationGraphService) {}

  public async inspect(context: TenantContext, executor: QueryExecutor) {
    return await this.graph.inspectGrowthProjection(context, executor);
  }

  public async apply(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly expectedVersion: number;
      readonly authorization: GrowthProjectionAuthorization;
    },
    executor: QueryExecutor,
  ): Promise<GraphChangeResult> {
    assertGrowthOrganizationPatch(input.patch);
    await verifyGrowthProjectionDecision(context, input.authorization, executor);
    return await this.graph.applyGrowthProjection(
      context,
      { commandId: input.commandId, expectedVersion: input.expectedVersion, patch: input.patch },
      executor,
    );
  }

  public async revert(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly expectedVersionId: string;
      readonly targetVersionId: string;
      readonly authorization: GrowthProjectionAuthorization;
    },
    executor: QueryExecutor,
  ): Promise<GraphChangeResult> {
    await verifyGrowthProjectionDecision(context, input.authorization, executor, "growth.revert");
    return await this.graph.revertGrowthProjection(
      context,
      {
        commandId: input.commandId,
        expectedVersionId: input.expectedVersionId,
        targetVersionId: input.targetVersionId,
      },
      executor,
    );
  }
}
