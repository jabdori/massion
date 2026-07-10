import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { TenantContext } from "@massion/identity";

import { RepositoryWatcher, type RepositoryIndexCommand, type RepositoryIndexCommandQueue } from "./index.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

class MemoryQueue implements RepositoryIndexCommandQueue {
  public readonly commands = new Map<string, RepositoryIndexCommand>();

  public async enqueue(_context: TenantContext, command: RepositoryIndexCommand): Promise<boolean> {
    if (this.commands.has(command.commandId)) return false;
    this.commands.set(command.commandId, command);
    return true;
  }
}

describe("Repository watcher change command", () => {
  it("Chokidar 5 adapter가 실제 file add를 ready 이후 queue command로 전달한다", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "massion-watcher-"));
    const queue = new MemoryQueue();
    const watcher = new RepositoryWatcher({
      context,
      repositoryId: "repository-live",
      root,
      watchSessionId: "session-live",
      queue,
      debounceMs: 25,
      maxEventsPerBatch: 100,
    });
    try {
      await watcher.start();
      await writeFile(path.join(root, "live.ts"), "export const live = true;\n");
      for (let attempt = 0; attempt < 100 && queue.commands.size === 0; attempt += 1) await delay(20);
      expect([...queue.commands.values()]).toEqual([
        expect.objectContaining({
          repositoryId: "repository-live",
          mode: "incremental",
          reason: "event_batch",
          changes: expect.objectContaining({ created: ["live.ts"] }),
        }),
      ]);
    } finally {
      await watcher.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ready 전 event를 버리고 add·change·unlink·addDir을 debounce된 canonical command로 합친다", async () => {
    const queue = new MemoryQueue();
    const watcher = new RepositoryWatcher({
      context,
      repositoryId: "repository-1",
      root: "/workspace/repository",
      watchSessionId: "session-1",
      queue,
      debounceMs: 60_000,
      maxEventsPerBatch: 100,
    });
    watcher.record("add", "ignored.ts");
    watcher.markReady();
    watcher.record("add", "src/new.ts");
    watcher.record("change", "src/new.ts");
    watcher.record("change", "src/change.ts");
    watcher.record("unlink", "src/delete.ts");
    watcher.record("addDir", "src/generated");
    await watcher.flush();

    expect([...queue.commands.values()]).toEqual([
      expect.objectContaining({
        mode: "reconcile",
        reason: "directory_changed",
        changes: {
          created: ["src/new.ts"],
          modified: ["src/change.ts"],
          deleted: ["src/delete.ts"],
          renamed: [],
          directories: ["src/generated"],
        },
      }),
    ]);
    expect(JSON.stringify([...queue.commands.values()])).not.toContain("ignored.ts");
    await watcher.close();
  });

  it("같은 batch의 한 unlink·add를 rename candidate로 만들고 command ID를 결정적으로 만든다", async () => {
    const queue = new MemoryQueue();
    const watcher = new RepositoryWatcher({
      context,
      repositoryId: "repository-1",
      root: "/workspace/repository",
      watchSessionId: "session-rename",
      queue,
      debounceMs: 60_000,
      maxEventsPerBatch: 100,
    });
    watcher.markReady();
    watcher.record("unlink", "src/old.ts");
    watcher.record("add", "src/new.ts");
    const first = await watcher.flush();

    expect(first?.changes).toEqual({
      created: [],
      modified: [],
      deleted: [],
      renamed: [{ previousPath: "src/old.ts", relativePath: "src/new.ts", confidence: "candidate" }],
      directories: [],
    });
    expect(first?.commandId).toMatch(/^[a-f0-9]{64}$/u);
    await watcher.close();
  });

  it("event flood, root 삭제와 watcher error를 path·error 원문 없이 reconcile command로 강등한다", async () => {
    const queue = new MemoryQueue();
    const watcher = new RepositoryWatcher({
      context,
      repositoryId: "repository-1",
      root: "/workspace/repository",
      watchSessionId: "session-degraded",
      queue,
      debounceMs: 60_000,
      maxEventsPerBatch: 2,
    });
    watcher.markReady();
    watcher.record("change", "one.ts");
    watcher.record("change", "two.ts");
    watcher.record("change", "secret-name.ts");
    const flood = await watcher.flush();
    watcher.record("unlinkDir", ".");
    const rootDeleted = await watcher.flush();
    watcher.recordError(new Error("sensitive /private/path"));
    const failed = await watcher.flush();

    expect([flood?.reason, rootDeleted?.reason, failed?.reason]).toEqual([
      "event_flood",
      "root_deleted",
      "watcher_error",
    ]);
    expect(flood?.changes).toEqual({ created: [], modified: [], deleted: [], renamed: [], directories: [] });
    expect(JSON.stringify(failed)).not.toContain("sensitive");
    expect(JSON.stringify(failed)).not.toContain("private/path");
    await watcher.close();
  });
});
