import { randomUUID } from "node:crypto";

import type { ApplicationCommandV1 } from "@massion/application";

interface CommandClient {
  command(value: unknown): Promise<unknown>;
}

const OPTIMIZATION_MUTATIONS = new Set([
  "optimization.policy.configure",
  "optimization.bundle.create",
  "optimization.bundle.export",
  "optimization.bundle.import",
  "optimization.evaluation.start",
  "optimization.evaluation.execute",
  "optimization.evaluation.complete",
  "optimization.recommend",
  "optimization.recommendation.approve",
  "optimization.batch.create",
  "optimization.batch.activate",
  "optimization.observation.record",
  "optimization.recover",
]);

export class TuiCommands {
  private readonly pending = new Set<string>();

  public constructor(
    private readonly client: CommandClient,
    private readonly userId: () => string,
  ) {}

  public async startRun(text: string): Promise<unknown> {
    return await this.send("run.start", "run.start", { request: { text, surface: "tui" } });
  }

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

  public async shareSubscriptionAccount(accountId: string, version: number): Promise<unknown> {
    return await this.subscriptionAccount("share", accountId, version);
  }

  public async unshareSubscriptionAccount(accountId: string, version: number): Promise<unknown> {
    return await this.subscriptionAccount("unshare", accountId, version);
  }

  public async disconnectSubscriptionAccount(accountId: string, version: number): Promise<unknown> {
    return await this.subscriptionAccount("disconnect", accountId, version);
  }

  public async configureSubscriptionPolicy(
    providerId: string,
    credentialPolicy: string,
    approvalMode: "automatic" | "review" | "deny",
    version: number,
  ): Promise<unknown> {
    return await this.send(
      `subscription.policy:${providerId}`,
      "subscription.policy.configure",
      { providerId, credentialPolicy, approvalMode },
      version,
    );
  }

  public async optimizationCommand(operation: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!OPTIMIZATION_MUTATIONS.has(operation)) throw new Error("TUI에서 허용되지 않은 최적화 operation입니다");
    return await this.send(`optimization:${operation}`, operation, payload);
  }

  private async subscriptionAccount(
    operation: "share" | "unshare" | "disconnect",
    accountId: string,
    version: number,
  ): Promise<unknown> {
    return await this.send(
      `subscription.account:${accountId}`,
      `subscription.account.${operation}`,
      { accountId },
      version,
    );
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
