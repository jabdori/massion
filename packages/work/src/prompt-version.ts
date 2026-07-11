import type { TenantContext } from "@massion/identity";
import type { QueryExecutor } from "@massion/storage";

export interface ResolveWorkPromptInput {
  readonly workId: string;
  readonly requesterUserId: string;
  readonly organizationVersionId: string;
  readonly contextVersionId?: string;
  readonly policyVersionId?: string;
}

export interface ResolvedWorkPrompt {
  readonly promptVersionId: string;
  readonly schemaVersion: "massion.work.prompt.v1";
}

export interface PromptVersionResolver {
  resolve(context: TenantContext, input: ResolveWorkPromptInput, executor: QueryExecutor): Promise<ResolvedWorkPrompt>;
  verify(context: TenantContext, promptVersionId: string, executor: QueryExecutor): Promise<void>;
}
