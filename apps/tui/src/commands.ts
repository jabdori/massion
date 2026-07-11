import { randomUUID } from "node:crypto";

import type { ApplicationCommandV1 } from "@massion/application";

interface CommandClient {
  command(value: unknown): Promise<unknown>;
}

export class TuiCommands {
  private readonly pending = new Set<string>();

  public constructor(
    private readonly client: CommandClient,
    private readonly userId: () => string,
  ) {}

  public async postMessage(input: {
    readonly workId: string;
    readonly roomId: string;
    readonly content: string;
    readonly messageType?: string;
  }): Promise<unknown> {
    return await this.send(`message:${input.roomId}`, "collaboration.message.post", {
      workId: input.workId,
      roomId: input.roomId,
      messageType: input.messageType ?? "question",
      authorKind: "user",
      authorId: this.userId(),
      content: input.content,
    });
  }

  public async cancelWork(input: { readonly workId: string; readonly revision: number }): Promise<unknown> {
    return await this.send(`work.cancel:${input.workId}`, "work.cancel", { workId: input.workId }, input.revision);
  }

  public async assignTask(input: {
    readonly workId: string;
    readonly taskId: string;
    readonly agentHandle: string;
    readonly revision: number;
  }): Promise<unknown> {
    return await this.send(
      `task.assign:${input.taskId}`,
      "task.assign",
      { workId: input.workId, taskId: input.taskId, agentHandle: input.agentHandle },
      input.revision,
    );
  }

  public async vote(input: {
    readonly approvalId: string;
    readonly vote: "approve" | "reject";
    readonly reason: string;
  }): Promise<unknown> {
    return await this.send(`approval.vote:${input.approvalId}`, "approval.vote", input);
  }

  public async cancelApproval(approvalId: string, reason: string): Promise<unknown> {
    return await this.send(`approval.cancel:${approvalId}`, "approval.cancel", { approvalId, reason });
  }

  public async cancelExecution(executionId: string, reason: string): Promise<unknown> {
    return await this.send(`runtime:${executionId}`, "runtime.cancel", { executionId, reason });
  }

  public async suspendExecution(executionId: string, reason: string): Promise<unknown> {
    return await this.send(`runtime:${executionId}`, "runtime.suspend", { executionId, reason });
  }

  public async resumeExecution(executionId: string, input?: unknown): Promise<unknown> {
    return await this.send(`runtime:${executionId}`, "runtime.resume", { executionId, input });
  }

  private async send(key: string, operation: string, payload: unknown, expectedRevision?: number): Promise<unknown> {
    if (this.pending.has(key)) throw new Error("같은 TUI 명령이 이미 진행 중입니다");
    this.pending.add(key);
    const command: ApplicationCommandV1 = {
      schemaVersion: "massion.application.v1",
      commandId: randomUUID(),
      correlationId: randomUUID(),
      operation,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      payload,
    };
    try {
      return await this.client.command(command);
    } finally {
      this.pending.delete(key);
    }
  }
}
