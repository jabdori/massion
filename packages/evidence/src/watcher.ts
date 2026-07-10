import { createHash } from "node:crypto";
import path from "node:path";

import { watch, type FSWatcher } from "chokidar";

import type { TenantContext } from "@massion/identity";

import type { IndexMode } from "./contracts.js";
import { normalizeRepositoryPath } from "./path.js";

export type RepositoryWatchEvent = "add" | "change" | "unlink" | "addDir" | "unlinkDir";
export type RepositoryIndexReason =
  "event_batch" | "directory_changed" | "event_flood" | "root_deleted" | "watcher_error" | "startup_recovery";

export interface RepositoryChangeSet {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly {
    readonly previousPath: string;
    readonly relativePath: string;
    readonly confidence: "candidate";
  }[];
  readonly directories: readonly string[];
}

export interface RepositoryIndexCommand {
  readonly commandId: string;
  readonly repositoryId: string;
  readonly mode: IndexMode;
  readonly parentIndexVersionId?: string;
  readonly reason: RepositoryIndexReason;
  readonly changes: RepositoryChangeSet;
}

export interface RepositoryIndexCommandQueue {
  enqueue(context: TenantContext, command: RepositoryIndexCommand): Promise<boolean>;
}

export interface RepositoryWatcherOptions {
  readonly context: TenantContext;
  readonly repositoryId: string;
  readonly root: string;
  readonly watchSessionId: string;
  readonly queue: RepositoryIndexCommandQueue;
  readonly debounceMs: number;
  readonly maxEventsPerBatch: number;
  readonly onDispatchError?: (error: unknown) => void;
}

type FileAction = "created" | "modified" | "deleted";

const EMPTY_CHANGES: RepositoryChangeSet = {
  created: [],
  modified: [],
  deleted: [],
  renamed: [],
  directories: [],
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class RepositoryWatcher {
  private ready = false;
  private sequence = 0;
  private eventCount = 0;
  private overflow = false;
  private rootDeleted = false;
  private watcherFailed = false;
  private readonly files = new Map<string, FileAction>();
  private readonly directories = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watcher: FSWatcher | undefined;

  public constructor(private readonly options: RepositoryWatcherOptions) {
    if (!options.repositoryId.trim() || !options.watchSessionId.trim())
      throw new Error("Repository watcher에는 repository와 session ID가 필요합니다");
    if (!Number.isInteger(options.debounceMs) || options.debounceMs < 1)
      throw new Error("Watcher debounceMs는 1 이상의 정수여야 합니다");
    if (!Number.isInteger(options.maxEventsPerBatch) || options.maxEventsPerBatch < 1)
      throw new Error("Watcher maxEventsPerBatch는 1 이상의 정수여야 합니다");
  }

  public async start(): Promise<void> {
    if (this.watcher) throw new Error("Repository watcher가 이미 시작됐습니다");
    this.watcher = watch(this.options.root, {
      cwd: this.options.root,
      ignoreInitial: true,
      followSymlinks: false,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
    });
    const ready = new Promise<void>((resolve, reject) => {
      this.watcher?.once("ready", () => {
        this.markReady();
        resolve();
      });
      this.watcher?.once("error", reject);
    });
    this.watcher.on("all", (event, eventPath) => {
      if (["add", "change", "unlink", "addDir", "unlinkDir"].includes(event))
        this.record(event as RepositoryWatchEvent, eventPath);
    });
    this.watcher.on("error", (error) => {
      this.recordError(error instanceof Error ? error : new Error("unknown watcher error"));
    });
    await ready;
  }

  public markReady(): void {
    this.ready = true;
  }

  public record(event: RepositoryWatchEvent, eventPath: string): void {
    if (!this.ready) return;
    this.eventCount += 1;
    if (this.eventCount > this.options.maxEventsPerBatch) {
      this.overflow = true;
      this.files.clear();
      this.directories.clear();
      this.schedule();
      return;
    }
    if (event === "unlinkDir" && this.isRootPath(eventPath)) {
      this.rootDeleted = true;
      this.files.clear();
      this.directories.clear();
      this.schedule();
      return;
    }
    let relativePath: string;
    try {
      relativePath = this.relativePath(eventPath);
    } catch {
      this.recordError(new Error("confined watcher path rejected"));
      return;
    }
    if (event === "addDir" || event === "unlinkDir") {
      this.directories.add(relativePath);
    } else {
      this.coalesceFile(event, relativePath);
    }
    this.schedule();
  }

  public recordError(error: Error): void {
    void error;
    if (!this.ready) return;
    this.watcherFailed = true;
    this.files.clear();
    this.directories.clear();
    this.schedule();
  }

  public async flush(): Promise<RepositoryIndexCommand | undefined> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (
      this.eventCount === 0 &&
      !this.overflow &&
      !this.rootDeleted &&
      !this.watcherFailed &&
      this.directories.size === 0
    ) {
      return undefined;
    }
    const reason: RepositoryIndexReason = this.watcherFailed
      ? "watcher_error"
      : this.rootDeleted
        ? "root_deleted"
        : this.overflow
          ? "event_flood"
          : this.directories.size > 0
            ? "directory_changed"
            : "event_batch";
    const changes = ["watcher_error", "root_deleted", "event_flood"].includes(reason)
      ? EMPTY_CHANGES
      : this.changeSet();
    const mode: IndexMode = reason === "event_batch" ? "incremental" : "reconcile";
    const ordinal = this.sequence;
    this.sequence += 1;
    const command: RepositoryIndexCommand = {
      commandId: sha256(
        canonicalJson({
          repositoryId: this.options.repositoryId,
          watchSessionId: this.options.watchSessionId,
          ordinal,
          mode,
          reason,
          changes,
        }),
      ),
      repositoryId: this.options.repositoryId,
      mode,
      reason,
      changes,
    };
    this.resetBatch();
    await this.options.queue.enqueue(this.options.context, command);
    return command;
  }

  public async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const watcher = this.watcher;
    this.watcher = undefined;
    try {
      await this.flush();
    } finally {
      if (watcher) await watcher.close();
    }
  }

  private coalesceFile(event: Extract<RepositoryWatchEvent, "add" | "change" | "unlink">, relativePath: string): void {
    const previous = this.files.get(relativePath);
    if (event === "add") {
      this.files.set(relativePath, previous === "deleted" ? "modified" : (previous ?? "created"));
      return;
    }
    if (event === "change") {
      this.files.set(relativePath, previous === "created" ? "created" : "modified");
      return;
    }
    if (previous === "created") this.files.delete(relativePath);
    else this.files.set(relativePath, "deleted");
  }

  private changeSet(): RepositoryChangeSet {
    const created = [...this.files.entries()]
      .filter(([, action]) => action === "created")
      .map(([relativePath]) => relativePath)
      .sort();
    const modified = [...this.files.entries()]
      .filter(([, action]) => action === "modified")
      .map(([relativePath]) => relativePath)
      .sort();
    const deleted = [...this.files.entries()]
      .filter(([, action]) => action === "deleted")
      .map(([relativePath]) => relativePath)
      .sort();
    const renamed: RepositoryChangeSet["renamed"] =
      created.length === 1 &&
      deleted.length === 1 &&
      modified.length === 0 &&
      this.directories.size === 0 &&
      this.eventCount === 2
        ? [{ previousPath: deleted[0] ?? "", relativePath: created[0] ?? "", confidence: "candidate" }]
        : [];
    return {
      created: renamed.length > 0 ? [] : created,
      modified,
      deleted: renamed.length > 0 ? [] : deleted,
      renamed,
      directories: [...this.directories].sort(),
    };
  }

  private relativePath(eventPath: string): string {
    const root = path.resolve(this.options.root);
    const candidate = path.isAbsolute(eventPath) ? path.resolve(eventPath) : path.resolve(root, eventPath);
    const relative = path.relative(root, candidate).replaceAll(path.sep, "/");
    return normalizeRepositoryPath(relative);
  }

  private isRootPath(eventPath: string): boolean {
    return eventPath === "." || path.resolve(this.options.root, eventPath) === path.resolve(this.options.root);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch((error: unknown) => this.options.onDispatchError?.(error));
    }, this.options.debounceMs);
  }

  private resetBatch(): void {
    this.eventCount = 0;
    this.overflow = false;
    this.rootDeleted = false;
    this.watcherFailed = false;
    this.files.clear();
    this.directories.clear();
  }
}
