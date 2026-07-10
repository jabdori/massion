import type { TenantContext } from "@massion/identity";
import type { DeclarationGovernanceGuard, QueryExecutor } from "@massion/storage";

import { GovernanceGate } from "./gate.js";

export class DeclarationGovernanceAdapter implements DeclarationGovernanceGuard {
  public constructor(
    private readonly context: TenantContext,
    private readonly gate: GovernanceGate,
  ) {}

  public async authorize(
    input: {
      readonly commandId: string;
      readonly projectId: string;
      readonly currentRevision: number;
      readonly contentHash: string;
      readonly environment: string;
      readonly approvalId?: string;
    },
    executor?: QueryExecutor,
  ): Promise<void> {
    await this.gate.authorize(
      this.context,
      {
        commandId: input.commandId,
        action: "declaration.apply",
        resource: {
          type: "Declaration",
          id: `${input.projectId}:${input.contentHash}`,
          revision: input.currentRevision,
        },
        environment: input.environment,
        riskClass: "write",
        external: false,
        executionId: `declaration-apply:${input.projectId}:${input.contentHash}`,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
      executor,
    );
  }
}
