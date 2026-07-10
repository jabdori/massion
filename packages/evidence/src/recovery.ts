import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import type { IndexVersion } from "./contracts.js";
import type { RepositoryStore } from "./repository-store.js";
import type { RepositoryIndexCommand, RepositoryIndexCommandQueue } from "./watcher.js";

export interface EvidenceIndexRecoveryOptions {
  readonly staleAfterMs?: number;
  readonly now?: () => number;
  readonly isStale?: (index: IndexVersion) => boolean;
}

export interface EvidenceIndexRecoveryResult {
  readonly recoveredIndexVersionIds: readonly string[];
  readonly command: RepositoryIndexCommand;
  readonly commandAccepted: boolean;
}

const EMPTY_CHANGES = { created: [], modified: [], deleted: [], renamed: [], directories: [] } as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value && typeof value === "object" && "toDate" in value) {
    const toDate: unknown = value.toDate;
    if (typeof toDate === "function") {
      const converted = (toDate as () => unknown).call(value);
      return converted instanceof Date ? converted.getTime() : undefined;
    }
  }
  return undefined;
}

export class EvidenceIndexRecovery {
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  public constructor(
    private readonly repositories: RepositoryStore,
    private readonly queue: RepositoryIndexCommandQueue,
    private readonly options: EvidenceIndexRecoveryOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.staleAfterMs) || this.staleAfterMs < 1)
      throw new Error("Index recovery staleAfterMs는 1 이상의 정수여야 합니다");
  }

  public async recover(context: TenantContext, repositoryId: string): Promise<EvidenceIndexRecoveryResult> {
    const versions = await this.repositories.listIndexes(context, repositoryId);
    const recoveredIndexVersionIds: string[] = [];
    for (const index of versions.filter((candidate) => candidate.status === "building" && this.isStale(candidate))) {
      await this.repositories.failIndex(context, {
        commandId: `${index.indexVersionId}:startup-recovery`,
        indexVersionId: index.indexVersionId,
        status: "partial",
        error: { category: "startup_recovery", causeId: sha256(index.indexVersionId) },
      });
      recoveredIndexVersionIds.push(index.indexVersionId);
    }
    const current = await this.repositories.getCurrentIndex(context, repositoryId);
    const command: RepositoryIndexCommand = {
      commandId: sha256(`startup-recovery\0${repositoryId}\0${current?.indexVersionId ?? "none"}`),
      repositoryId,
      mode: current ? "reconcile" : "full",
      ...(current ? { parentIndexVersionId: current.indexVersionId } : {}),
      reason: "startup_recovery",
      changes: EMPTY_CHANGES,
    };
    const commandAccepted = await this.queue.enqueue(context, command);
    return { recoveredIndexVersionIds, command, commandAccepted };
  }

  private isStale(index: IndexVersion): boolean {
    if (this.options.isStale) return this.options.isStale(index);
    const updatedAt = timestamp(index.updatedAt);
    return updatedAt === undefined || this.now() - updatedAt >= this.staleAfterMs;
  }
}
