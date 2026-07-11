import type { DynamicValue } from "@voltagent/core";

import type { TenantContext } from "@massion/identity";

export const MASSION_RUNTIME_EXECUTION_CONTEXT_KEY = "massion.executionId";
export const MASSION_TENANT_CONTEXT_KEY = "massion.tenantContext";

export interface ResolvedAgentConfiguration {
  readonly promptVersionId: string;
  readonly promptChecksum: string;
  readonly memoryVersionIds: readonly string[];
  readonly instruction: string;
  readonly instructionChecksum: string;
}

export interface AgentConfigurationReader {
  resolve(
    context: TenantContext,
    input: { readonly executionId: string; readonly agentHandle: string },
  ): Promise<ResolvedAgentConfiguration>;
}

function tenantContext(value: unknown): TenantContext {
  if (!value || typeof value !== "object") throw new Error("VoltAgent context에 Massion TenantContext가 없습니다");
  const candidate = value as Partial<TenantContext>;
  if (
    typeof candidate.userId !== "string" ||
    typeof candidate.organizationId !== "string" ||
    typeof candidate.membershipId !== "string" ||
    (candidate.role !== "owner" && candidate.role !== "admin" && candidate.role !== "member")
  ) {
    throw new Error("VoltAgent context의 Massion TenantContext가 유효하지 않습니다");
  }
  return candidate as TenantContext;
}

export class AgentInstructionRegistry {
  public constructor(private readonly reader: AgentConfigurationReader) {}

  public instructions(agentHandle: string): DynamicValue<string> {
    return async ({ context }) => {
      const executionId = context.get(MASSION_RUNTIME_EXECUTION_CONTEXT_KEY);
      if (typeof executionId !== "string") throw new Error("VoltAgent context에 Massion execution ID가 없습니다");
      const tenant = tenantContext(context.get(MASSION_TENANT_CONTEXT_KEY));
      const resolved = await this.reader.resolve(tenant, { executionId, agentHandle });
      return resolved.instruction;
    };
  }
}
