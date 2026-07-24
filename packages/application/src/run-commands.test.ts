import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { TenantContext } from "@massion/identity";

import type { ApplicationCommandDescriptor } from "./command-registry.js";
import { registerApplicationRunCommands } from "./run-commands.js";

const context: TenantContext = {
  userId: "run-user",
  organizationId: "run-org",
  membershipId: "run-member",
  role: "owner",
};

describe("Application run commands", () => {
  it("workspace file 경로를 정규화하고 workspace 밖 입력을 거부한다", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "massion-run-workspace-"));
    const workspaceRoot = join(temporaryRoot, "workspace");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};");
    await writeFile(join(temporaryRoot, "outside.ts"), "export {};");
    await symlink(join(temporaryRoot, "outside.ts"), join(workspaceRoot, "outside.ts"));
    const canonicalWorkspaceRoot = await realpath(workspaceRoot);
    try {
      const descriptors = new Map<string, ApplicationCommandDescriptor>();
      const requests: unknown[] = [];
      registerApplicationRunCommands(
        {
          register: (descriptor: ApplicationCommandDescriptor) => descriptors.set(descriptor.operation, descriptor),
        } as never,
        {
          store: {
            start: async (_context, input) => {
              requests.push(input.request);
              return {
                runId: "run-workspace-paths-1",
                organizationId: context.organizationId,
                commandId: input.commandId,
                correlationId: input.correlationId,
                request: input.request,
                stage: "intake" as const,
                status: "ready" as const,
                leaseGeneration: 0,
              };
            },
          },
          coordinator: { cancel: async () => ({}) as never, retryBlocked: async () => ({}) as never },
          schedule: async () => undefined,
          workspaces: {
            get: async () => ({ path: canonicalWorkspaceRoot, status: "active" }) as never,
          },
        },
      );
      const start = descriptors.get("run.start");
      if (!start) throw new Error("run.start descriptor가 없습니다");

      for (const request of [
        { text: "파일 검토", workspacePaths: ["src/index.ts"] },
        { text: "파일 검토", workspaceId: "workspace-1", workspacePaths: ["/src/index.ts"] },
        { text: "파일 검토", workspaceId: "workspace-1", workspacePaths: ["src/../outside.ts"] },
      ]) {
        expect(() => start.validate({ request })).toThrow("workspace file 경로");
      }

      const payload = start.validate({
        request: {
          text: "파일 검토",
          workspaceId: "workspace-1",
          workspacePaths: ["src/index.ts", "src//index.ts"],
        },
      });
      await start.handle(
        context,
        {
          schemaVersion: "massion.application.v1",
          commandId: "run-workspace-paths-command-1",
          correlationId: "run-workspace-paths-correlation-1",
          operation: "run.start",
          payload,
        },
        payload,
      );
      expect(requests).toEqual([
        { text: "파일 검토", workspaceId: "workspace-1", workspacePaths: ["src/index.ts"] },
      ]);
      expect(() => start.validate({
        request: { text: "파일 검토", workspaceId: "workspace-1", workspacePaths: Array.from({ length: 21 }, (_, index) => `src/${index}.ts`) },
      })).toThrow("workspace file 경로");

      const escaped = start.validate({
        request: { text: "파일 검토", workspaceId: "workspace-1", workspacePaths: ["outside.ts"] },
      });
      await expect(
        start.handle(
          context,
          {
            schemaVersion: "massion.application.v1",
            commandId: "run-workspace-paths-command-2",
            correlationId: "run-workspace-paths-correlation-2",
            operation: "run.start",
            payload: escaped,
          },
          escaped,
        ),
      ).rejects.toThrow("workspace 밖");

      const workspaceOnly = start.validate({ request: { text: "파일 검토", workspaceId: "workspace-1" } });
      const archivedDescriptors = new Map<string, ApplicationCommandDescriptor>();
      registerApplicationRunCommands(
        { register: (descriptor: ApplicationCommandDescriptor) => archivedDescriptors.set(descriptor.operation, descriptor) } as never,
        {
          store: { start: async () => ({}) as never },
          coordinator: { cancel: async () => ({}) as never, retryBlocked: async () => ({}) as never },
          schedule: async () => undefined,
          workspaces: { get: async () => ({ path: canonicalWorkspaceRoot, status: "archived" }) as never },
        },
      );
      const archivedStart = archivedDescriptors.get("run.start");
      if (!archivedStart) throw new Error("run.start descriptor가 없습니다");
      await expect(archivedStart.handle(context, { schemaVersion: "massion.application.v1", commandId: "run-workspace-paths-command-3", correlationId: "run-workspace-paths-correlation-3", operation: "run.start", payload: workspaceOnly }, workspaceOnly)).rejects.toThrow("active");

      await rm(workspaceRoot, { recursive: true, force: true });
      await writeFile(workspaceRoot, "not a directory");
      await expect(start.handle(context, { schemaVersion: "massion.application.v1", commandId: "run-workspace-paths-command-4", correlationId: "run-workspace-paths-correlation-4", operation: "run.start", payload: workspaceOnly }, workspaceOnly)).rejects.toThrow("directory");
      await rm(workspaceRoot);
      await rm(workspaceRoot, { recursive: true, force: true });
      await symlink(temporaryRoot, workspaceRoot);
      await expect(start.handle(context, { schemaVersion: "massion.application.v1", commandId: "run-workspace-paths-command-5", correlationId: "run-workspace-paths-correlation-5", operation: "run.start", payload: workspaceOnly }, workspaceOnly)).rejects.toThrow("canonical");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("run.start를 accepted로 기록하고 schedule하며 cancel을 coordinator로 보낸다", async () => {
    const descriptors = new Map<string, ApplicationCommandDescriptor>();
    const scheduled: string[] = [];
    const cancelled: string[] = [];
    const view = (status: "ready" | "cancelled" | "completed") => ({
      runId: "run-command-1",
      organizationId: context.organizationId,
      commandId: "run-start-command-0001",
      correlationId: "run-start-correlation-0001",
      request: {},
      stage: status === "ready" ? ("intake" as const) : ("terminal" as const),
      status,
      leaseGeneration: 0,
    });
    registerApplicationRunCommands(
      {
        register: (descriptor: ApplicationCommandDescriptor) => {
          descriptors.set(descriptor.operation, descriptor);
        },
      } as never,
      {
        store: { start: async () => view("ready") },
        coordinator: {
          cancel: async (_context, runId) => {
            cancelled.push(runId);
            return view("cancelled");
          },
          retryBlocked: async () => view("completed"),
        },
        schedule: async (_context, runId) => {
          scheduled.push(runId);
        },
      },
    );
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "run-start-command-0001",
      correlationId: "run-start-correlation-0001",
      operation: "run.start",
      payload: {},
    };
    const start = descriptors.get("run.start");
    if (!start) throw new Error("run.start descriptor가 없습니다");
    const payload = start.validate({ request: { text: "제품화" } });
    await expect(start.handle(context, command, payload)).resolves.toMatchObject({
      outcome: "accepted",
      resource: { id: "run-command-1" },
    });
    expect(scheduled).toEqual(["run-command-1"]);
    const cancel = descriptors.get("run.cancel");
    if (!cancel) throw new Error("run.cancel descriptor가 없습니다");
    await cancel.handle(context, { ...command, operation: "run.cancel" }, cancel.validate({ runId: "run-command-1" }));
    expect(cancelled).toEqual(["run-command-1"]);
  });

  it("차단된 run 재시도는 외부 command ID를 재시도 시도 ID로 전달한다", async () => {
    const descriptors = new Map<string, ApplicationCommandDescriptor>();
    const retryCalls: Array<{ runId: string; retryAttemptId: string }> = [];
    const completed = {
      runId: "run-command-retry-1",
      organizationId: context.organizationId,
      commandId: "run-start-command-0002",
      correlationId: "run-start-correlation-0002",
      request: {},
      stage: "terminal" as const,
      status: "completed" as const,
      leaseGeneration: 2,
    };
    registerApplicationRunCommands(
      {
        register: (descriptor: ApplicationCommandDescriptor) => {
          descriptors.set(descriptor.operation, descriptor);
        },
      } as never,
      {
        store: { start: async () => completed },
        coordinator: {
          cancel: async () => completed,
          retryBlocked: async (_context, runId, retryAttemptId) => {
            retryCalls.push({ runId, retryAttemptId });
            return completed;
          },
        },
        schedule: async () => undefined,
      },
    );
    const resume = descriptors.get("run.resume");
    if (!resume) throw new Error("run.resume descriptor가 없습니다");
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "run-resume-retry-command-0001",
      correlationId: "run-resume-retry-correlation-0001",
      operation: "run.resume",
      payload: {},
    };
    const payload = resume.validate({ runId: "run-command-retry-1", retryBlocked: true });

    await expect(resume.handle(context, command, payload)).resolves.toMatchObject({ outcome: "succeeded" });
    expect(retryCalls).toEqual([{ runId: "run-command-retry-1", retryAttemptId: "run-resume-retry-command-0001" }]);
  });

  it("work:write run.resume으로 승인 대기 실행을 직접 재개할 수 없다", () => {
    const descriptors = new Map<string, ApplicationCommandDescriptor>();
    registerApplicationRunCommands(
      {
        register: (descriptor: ApplicationCommandDescriptor) => descriptors.set(descriptor.operation, descriptor),
      } as never,
      {
        store: { start: async () => ({}) as never },
        coordinator: { cancel: async () => ({}) as never, retryBlocked: async () => ({}) as never },
        schedule: async () => undefined,
      },
    );
    const resume = descriptors.get("run.resume");
    if (!resume) throw new Error("run.resume descriptor가 없습니다");

    expect(resume.requiredScopes).toEqual(["work:write"]);
    expect(() =>
      resume.validate({
        runId: "run-awaiting-approval-0001",
        resumeInput: { approvalId: "approval-direct-resume-0001" },
      }),
    ).toThrow("알 수 없는 필드");
    expect(() => resume.validate({ runId: "run-awaiting-approval-0001" })).toThrow("재시도 전용");
    expect(() => resume.validate({ runId: "run-awaiting-approval-0001", retryBlocked: false })).toThrow("retryBlocked");
  });
});
