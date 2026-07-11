import type { TenantContext } from "@massion/identity";
import type { QueryExecutor } from "@massion/storage";
import { PolicyGrowthProjection } from "@massion/governance";
import { OrganizationGrowthProjection } from "@massion/organization";

import { growthChecksum, type MemoryEntry, type PromptAgentSection, type PromptMemoryStore } from "./prompt-memory.js";
import type { SuggestionTargetKind } from "./reflection.js";

export interface GrowthTargetState {
  readonly targetKind: SuggestionTargetKind;
  readonly versionId: string;
  readonly revision: number;
  readonly checksum: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
}

export interface InspectGrowthTargetInput {
  readonly suggestionId: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

export interface ValidateGrowthTargetInput extends InspectGrowthTargetInput {
  readonly expectedVersionId: string;
  readonly expectedChecksum: string;
  readonly governanceDecisionId: string;
  readonly suggestionRevision: number;
  readonly approvalId?: string;
}

export interface ApplyGrowthTargetInput extends ValidateGrowthTargetInput {
  readonly commandId: string;
}

export interface RevertGrowthTargetInput {
  readonly commandId: string;
  readonly suggestionId: string;
  readonly expectedVersionId: string;
  readonly targetVersionId: string;
  readonly governanceDecisionId: string;
}

export interface GrowthTargetResult {
  readonly before: GrowthTargetState;
  readonly after: GrowthTargetState;
}

export interface GrowthTargetPort {
  inspect(context: TenantContext, input: InspectGrowthTargetInput, executor: QueryExecutor): Promise<GrowthTargetState>;
  validate(context: TenantContext, input: ValidateGrowthTargetInput, executor: QueryExecutor): Promise<void>;
  apply(context: TenantContext, input: ApplyGrowthTargetInput, executor: QueryExecutor): Promise<GrowthTargetResult>;
  revert(context: TenantContext, input: RevertGrowthTargetInput, executor: QueryExecutor): Promise<GrowthTargetResult>;
}

export function growthTargetChecksum(value: unknown): string {
  return growthChecksum(value);
}

function exactKeys(patch: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const keys = Object.keys(patch).sort();
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new Error("Growth target patch schema가 일치하지 않습니다");
  }
}

function records(value: unknown, key: string): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>)[key])) {
    throw new Error(`Growth target snapshot의 ${key}가 유효하지 않습니다`);
  }
  return (value as Record<string, unknown>)[key] as Array<Record<string, unknown>>;
}

export function applyGrowthPatch(
  kind: SuggestionTargetKind,
  snapshot: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (kind === "prompt") {
    exactKeys(patch, ["agentHandle", "instruction"]);
    const sections = records(snapshot, "sections");
    if (!sections.some((section) => section.agentHandle === patch.agentHandle))
      throw new Error("Prompt target을 찾을 수 없습니다");
    return {
      ...snapshot,
      sections: sections.map((section) =>
        section.agentHandle === patch.agentHandle ? { ...section, instruction: patch.instruction } : section,
      ),
    };
  }
  if (kind === "memory") {
    const allowed = ["kind", "key", "value", "sourceReferenceIds"];
    const keys = Object.keys(patch).sort();
    if (!keys.every((key) => allowed.includes(key)) || !["kind", "key", "value"].every((key) => keys.includes(key))) {
      throw new Error("Growth target patch schema가 일치하지 않습니다");
    }
    const entries = records(snapshot, "entries");
    const sourceReferenceIds = Array.isArray(patch.sourceReferenceIds) ? patch.sourceReferenceIds : [];
    return {
      ...snapshot,
      entries: [...entries.filter((entry) => entry.key !== patch.key), { ...patch, sourceReferenceIds }],
    };
  }
  if (kind === "policy") {
    exactKeys(patch, ["policyId", "policyText"]);
    const text = String(patch.policyText);
    if (/growth\.(?:adopt|configure)|policy\.activate|emergency\.stop\.disable/iu.test(text)) {
      throw new Error("self-amplification policy는 채택할 수 없습니다");
    }
    const policies = snapshot.policies;
    if (!policies || typeof policies !== "object" || Array.isArray(policies))
      throw new Error("Policy snapshot이 유효하지 않습니다");
    return { ...snapshot, policies: { ...(policies as Record<string, unknown>), [String(patch.policyId)]: text } };
  }
  exactKeys(patch, ["handle", "responsibility"]);
  const nodes = records(snapshot, "nodes");
  if (!nodes.some((node) => node.handle === patch.handle)) throw new Error("Organization target을 찾을 수 없습니다");
  return {
    ...snapshot,
    nodes: nodes.map((node) =>
      node.handle === patch.handle ? { ...node, responsibility: patch.responsibility } : node,
    ),
  };
}

export class GrowthTargetRegistry {
  private readonly ports: ReadonlyMap<SuggestionTargetKind, GrowthTargetPort>;

  public constructor(ports: Readonly<Record<SuggestionTargetKind, GrowthTargetPort>>) {
    this.ports = new Map(Object.entries(ports) as Array<[SuggestionTargetKind, GrowthTargetPort]>);
  }

  public get(kind: SuggestionTargetKind): GrowthTargetPort {
    const port = this.ports.get(kind);
    if (!port) throw new Error(`Growth target port가 없습니다: ${kind}`);
    return port;
  }
}

abstract class BaseGrowthTarget implements GrowthTargetPort {
  public abstract inspect(
    context: TenantContext,
    input: InspectGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetState>;
  public async validate(
    context: TenantContext,
    input: ValidateGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<void> {
    const current = await this.inspect(context, input, executor);
    if (current.versionId !== input.expectedVersionId || current.checksum !== input.expectedChecksum)
      throw new Error("Growth target version 또는 checksum이 stale합니다");
  }
  public abstract apply(
    context: TenantContext,
    input: ApplyGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetResult>;
  public revert(): Promise<GrowthTargetResult> {
    return Promise.reject(new Error("Growth target revert는 effect 단계에서 활성화됩니다"));
  }
}

export class PromptGrowthTarget extends BaseGrowthTarget {
  public constructor(private readonly store: PromptMemoryStore) {
    super();
  }
  public async inspect(
    context: TenantContext,
    _input: InspectGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetState> {
    const value = await this.store.inspectPromptGrowth(context, executor);
    return {
      targetKind: "prompt",
      versionId: value.promptDefinitionVersionId,
      revision: value.version,
      checksum: value.checksum,
      snapshot: { sections: value.sections },
    };
  }
  public async apply(
    context: TenantContext,
    input: ApplyGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetResult> {
    await this.validate(context, input, executor);
    const before = await this.inspect(context, input, executor);
    const next = applyGrowthPatch("prompt", before.snapshot, input.patch);
    const value = await this.store.applyPromptGrowth(
      context,
      {
        commandId: input.commandId,
        expectedVersionId: before.versionId,
        sections: next.sections as readonly PromptAgentSection[],
      },
      executor,
    );
    return {
      before,
      after: {
        targetKind: "prompt",
        versionId: value.promptDefinitionVersionId,
        revision: value.version,
        checksum: value.checksum,
        snapshot: { sections: value.sections },
      },
    };
  }
}

export class MemoryGrowthTarget extends BaseGrowthTarget {
  public constructor(private readonly store: PromptMemoryStore) {
    super();
  }
  public async inspect(
    context: TenantContext,
    _input: InspectGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetState> {
    const value = await this.store.inspectMemoryGrowth(context, executor);
    return {
      targetKind: "memory",
      versionId: value.memoryVersionId,
      revision: value.version,
      checksum: value.checksum,
      snapshot: { entries: value.entries },
    };
  }
  public async apply(
    context: TenantContext,
    input: ApplyGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetResult> {
    await this.validate(context, input, executor);
    const before = await this.inspect(context, input, executor);
    const next = applyGrowthPatch("memory", before.snapshot, input.patch);
    const value = await this.store.applyMemoryGrowth(
      context,
      {
        commandId: input.commandId,
        expectedVersionId: before.versionId,
        entries: next.entries as readonly MemoryEntry[],
      },
      executor,
    );
    return {
      before,
      after: {
        targetKind: "memory",
        versionId: value.memoryVersionId,
        revision: value.version,
        checksum: value.checksum,
        snapshot: { entries: value.entries },
      },
    };
  }
}

export class PolicyGrowthTarget extends BaseGrowthTarget {
  public constructor(private readonly projection: PolicyGrowthProjection) {
    super();
  }
  public async inspect(
    context: TenantContext,
    _input: InspectGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetState> {
    const value = await this.projection.inspect(context, executor);
    return {
      targetKind: "policy",
      versionId: value.version.policy_version_id,
      revision: value.version.version,
      checksum: value.version.checksum,
      snapshot: { schema: value.bundle.schema, policies: value.bundle.policies, requirements: value.requirements },
    };
  }
  public async apply(
    context: TenantContext,
    input: ApplyGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetResult> {
    await this.validate(context, input, executor);
    const before = await this.inspect(context, input, executor);
    const value = await this.projection.apply(
      context,
      {
        commandId: input.commandId,
        patch: input.patch,
        expectedVersionId: before.versionId,
        authorization: {
          decisionId: input.governanceDecisionId,
          suggestionId: input.suggestionId,
          targetRevision: input.suggestionRevision,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
      },
      executor,
    );
    return {
      before,
      after: {
        targetKind: "policy",
        versionId: value.version.policy_version_id,
        revision: value.version.version,
        checksum: value.version.checksum,
        snapshot: { schema: value.bundle.schema, policies: value.bundle.policies, requirements: value.requirements },
      },
    };
  }
}

export class OrganizationGrowthTarget extends BaseGrowthTarget {
  public constructor(private readonly projection: OrganizationGrowthProjection) {
    super();
  }
  public async inspect(
    context: TenantContext,
    _input: InspectGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetState> {
    const value = await this.projection.inspect(context, executor);
    const snapshot = { nodes: value.nodes };
    return {
      targetKind: "organization",
      versionId: value.version.version_id,
      revision: value.version.version,
      checksum: growthChecksum({ versionId: value.version.version_id, ...snapshot }),
      snapshot,
    };
  }
  public async apply(
    context: TenantContext,
    input: ApplyGrowthTargetInput,
    executor: QueryExecutor,
  ): Promise<GrowthTargetResult> {
    await this.validate(context, input, executor);
    const before = await this.inspect(context, input, executor);
    const value = await this.projection.apply(
      context,
      {
        commandId: input.commandId,
        patch: input.patch,
        expectedVersion: before.revision,
        authorization: {
          decisionId: input.governanceDecisionId,
          suggestionId: input.suggestionId,
          targetRevision: input.suggestionRevision,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
      },
      executor,
    );
    const snapshot = { nodes: value.nodes };
    return {
      before,
      after: {
        targetKind: "organization",
        versionId: value.version.version_id,
        revision: value.version.version,
        checksum: growthChecksum({ versionId: value.version.version_id, ...snapshot }),
        snapshot,
      },
    };
  }
}
