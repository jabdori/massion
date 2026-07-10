import type { TenantContext } from "@massion/identity";

import type { IndexedRelation, IndexedSymbol, IndexStore } from "./index-store.js";
import type { RepositoryStore } from "./repository-store.js";

export interface CodeGraphInput {
  readonly repositoryId: string;
  readonly indexVersionId: string;
  readonly symbolKey: string;
  readonly direction: "outgoing" | "incoming" | "both";
  readonly depth: number;
}

export interface CodeGraphResult {
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly indexVersionId: string;
  readonly root: IndexedSymbol;
  readonly nodes: readonly IndexedSymbol[];
  readonly edges: readonly IndexedRelation[];
  readonly unresolved: readonly IndexedRelation[];
}

export class CodeGraphService {
  public constructor(
    private readonly repositories: RepositoryStore,
    private readonly indexes: IndexStore,
  ) {}

  public async neighbors(context: TenantContext, input: CodeGraphInput): Promise<CodeGraphResult> {
    if (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 5)
      throw new Error("Code graph depth는 1 이상 5 이하여야 합니다");
    const index = await this.repositories.getIndex(context, input.indexVersionId);
    if (index.repositoryId !== input.repositoryId) throw new Error("IndexVersion과 Repository가 일치하지 않습니다");
    if (!["complete", "superseded"].includes(index.status))
      throw new Error(`완전한 IndexVersion만 graph에 사용할 수 있습니다: ${index.status}`);
    const snapshot = await this.indexes.getSnapshot(context, input.indexVersionId);
    const symbols = new Map(snapshot.symbols.map((symbol) => [symbol.symbolKey, symbol]));
    const root = symbols.get(input.symbolKey);
    if (!root) throw new Error(`Graph 시작 Symbol을 찾을 수 없습니다: ${input.symbolKey}`);
    for (const relation of snapshot.relations.filter((item) => item.resolved)) {
      if (relation.targetSymbolKey && !symbols.has(relation.targetSymbolKey))
        throw new Error(`Relation target이 IndexVersion 밖을 가리킵니다: ${relation.relationKey}`);
      if (relation.sourceSymbolKey && !symbols.has(relation.sourceSymbolKey))
        throw new Error(`Relation source가 IndexVersion 밖을 가리킵니다: ${relation.relationKey}`);
    }

    const visited = new Set([input.symbolKey]);
    let frontier = new Set([input.symbolKey]);
    const nodes: IndexedSymbol[] = [];
    const edges = new Map<string, IndexedRelation>();
    const unresolved = new Map<string, IndexedRelation>();
    for (let level = 0; level < input.depth && frontier.size > 0; level += 1) {
      const next = new Set<string>();
      for (const relation of snapshot.relations) {
        if (!relation.resolved) {
          if (
            (input.direction !== "incoming" && relation.sourceSymbolKey && frontier.has(relation.sourceSymbolKey)) ||
            (input.direction !== "outgoing" && relation.targetSymbolKey && frontier.has(relation.targetSymbolKey))
          ) {
            unresolved.set(relation.relationKey, relation);
          }
          continue;
        }
        const source = relation.sourceSymbolKey;
        const target = relation.targetSymbolKey;
        if (!source || !target) continue;
        const outgoing = input.direction !== "incoming" && frontier.has(source);
        const incoming = input.direction !== "outgoing" && frontier.has(target);
        if (!outgoing && !incoming) continue;
        edges.set(relation.relationKey, relation);
        const neighbor = outgoing ? target : source;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.add(neighbor);
          const symbol = symbols.get(neighbor);
          if (symbol) nodes.push(symbol);
        }
      }
      frontier = next;
    }
    nodes.sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
    return {
      repositoryId: input.repositoryId,
      repositoryRevisionId: index.repositoryRevisionId,
      indexVersionId: input.indexVersionId,
      root,
      nodes,
      edges: [...edges.values()],
      unresolved: [...unresolved.values()],
    };
  }
}
