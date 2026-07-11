import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  EXTENSION_RPC_PROTOCOL,
  createRpcFrameParser,
  validateHandshake,
  type ExtensionHandshake,
  type ExtensionRpcFrame,
  type ExtensionTrustLevel,
} from "@massion/extension-sdk";

import {
  assertSandboxEligibility,
  extensionSandboxPolicyDigest,
  nodePermissionArguments,
  type SandboxBackend,
  type SandboxReceipt,
} from "./sandbox.js";

interface PendingRequest {
  readonly expectedOperation: string;
  readonly resolve: (frame: ExtensionRpcFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class WorkerRpcChannel {
  private readonly parser = createRpcFrameParser({ maxFrameBytes: 64 * 1024, maxDepth: 12 });
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private failure?: Error;
  private stderrSummary = "";
  private readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const frame = this.parser.parse(line);
        const request = this.pending.get(frame.requestId);
        if (!request) throw new Error("Extension worker가 알 수 없는 requestId로 응답했습니다");
        this.pending.delete(frame.requestId);
        clearTimeout(request.timer);
        if (frame.operation !== request.expectedOperation) {
          request.reject(
            new Error(
              `Extension worker operation이 일치하지 않습니다: ${frame.operation} != ${request.expectedOperation}`,
            ),
          );
          return;
        }
        request.resolve(frame);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    lines.on("error", (error) => {
      this.fail(error);
    });
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (this.stderrSummary.length < 4096) {
        this.stderrSummary += chunk
          .toString("utf8")
          .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/giu, "Bearer [REDACTED]")
          .replace(/\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s]+/giu, "[REDACTED_URL]")
          .slice(0, 4096 - this.stderrSummary.length);
      }
      if (stderrBytes > 64 * 1024) this.fail(new Error("Extension worker stderr byte 상한을 초과했습니다"));
    });
    child.on("error", (error) => {
      this.fail(error);
    });
    this.exit = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        if (this.pending.size > 0) {
          const detail = this.stderrSummary.trim();
          this.fail(
            new Error(`Extension worker가 응답 전에 종료됐습니다: ${String(code)}${detail ? ` (${detail})` : ""}`),
          );
        }
        resolveExit({ code, signal });
      });
    });
  }

  public async request(
    operation: string,
    payload: unknown,
    expectedOperation: string,
    timeoutMs: number,
  ): Promise<ExtensionRpcFrame> {
    if (this.failure) throw this.failure;
    const requestId = randomUUID();
    const frame: ExtensionRpcFrame = {
      protocol: EXTENSION_RPC_PROTOCOL,
      requestId,
      sequence: ++this.sequence,
      operation,
      payload,
    };
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > 64 * 1024)
      throw new Error("Extension Host RPC frame byte 상한을 초과했습니다");
    return await new Promise<ExtensionRpcFrame>((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`Extension worker ${operation} timeout`);
        reject(error);
        this.fail(error);
      }, timeoutMs);
      this.pending.set(requestId, { expectedOperation, resolve: resolveRequest, reject, timer });
      this.child.stdin.write(encoded, (error) => {
        if (error) {
          const pending = this.pending.get(requestId);
          if (!pending) return;
          this.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(error);
        }
      });
    });
  }

  public terminate(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }

  public closeInput(): void {
    this.child.stdin.end();
  }

  public async waitForExit(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exit,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Extension worker stop timeout"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public observeExit(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
    return this.exit;
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.terminate();
  }
}

export interface StartExtensionWorkerInput {
  readonly trustLevel: ExtensionTrustLevel;
  readonly versionDirectory: string;
  readonly entrypoint: string;
  readonly manifestDigest: string;
  readonly sdkVersion: string;
  readonly contributions: readonly string[];
  readonly healthTimeoutMs: number;
  readonly stopTimeoutMs: number;
}

export interface ExtensionWorkerHandle {
  readonly processId: number;
  readonly sandboxReceipt?: SandboxReceipt;
  readonly exited?: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  invoke(contribution: string, input: unknown, timeoutMs: number): Promise<unknown>;
  stop(): Promise<void>;
  terminate(): void;
}

function safeEnvironment(): Readonly<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  };
}

export class ExtensionWorkerSupervisor {
  public constructor(private readonly sandboxBackend?: SandboxBackend) {}

  public async start(input: StartExtensionWorkerInput): Promise<ExtensionWorkerHandle> {
    const versionDirectory = realpathSync(input.versionDirectory);
    const args = nodePermissionArguments(versionDirectory, input.entrypoint);
    const policyDigest = extensionSandboxPolicyDigest({ ...input, versionDirectory });
    let child: ChildProcessWithoutNullStreams;
    let sandboxReceipt: SandboxReceipt | undefined;
    if (this.sandboxBackend) {
      const sandboxed = await this.sandboxBackend.spawn({
        command: process.execPath,
        args,
        cwd: versionDirectory,
        environment: safeEnvironment(),
        policyDigest,
      });
      child = sandboxed.child;
      sandboxReceipt = assertSandboxEligibility(input.trustLevel, policyDigest, sandboxed.receipt);
      if (child.pid !== sandboxReceipt?.processId) {
        child.kill("SIGKILL");
        throw new Error("Extension sandbox receipt process가 실제 worker와 일치하지 않습니다");
      }
    } else {
      assertSandboxEligibility(input.trustLevel, policyDigest);
      child = spawn(process.execPath, [...args], {
        cwd: versionDirectory,
        shell: false,
        env: safeEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    const channel = new WorkerRpcChannel(child);
    try {
      const nonce = randomUUID();
      const handshake = await channel.request("host.handshake", { nonce }, "worker.handshake", input.healthTimeoutMs);
      validateHandshake(handshake.payload as ExtensionHandshake, {
        nonce,
        manifestDigest: input.manifestDigest,
        sdkVersion: input.sdkVersion,
        contributions: input.contributions,
      });
      const health = await channel.request("health.check", {}, "health.result", input.healthTimeoutMs);
      if (
        !health.payload ||
        typeof health.payload !== "object" ||
        (health.payload as Record<string, unknown>).status !== "healthy"
      ) {
        throw new Error("Extension worker health 결과가 healthy가 아닙니다");
      }
    } catch (error) {
      channel.terminate();
      await channel.waitForExit(input.stopTimeoutMs).catch(() => undefined);
      throw error;
    }
    const contributions = new Set(input.contributions);
    return {
      processId: child.pid ?? 0,
      exited: channel.observeExit(),
      ...(sandboxReceipt === undefined ? {} : { sandboxReceipt }),
      async invoke(contribution: string, invocationInput: unknown, timeoutMs: number): Promise<unknown> {
        if (!contributions.has(contribution)) throw new Error("선언하지 않은 Extension contribution입니다");
        return (
          await channel.request(
            "contribution.invoke",
            { contribution, input: invocationInput },
            "contribution.result",
            timeoutMs,
          )
        ).payload;
      },
      async stop(): Promise<void> {
        await channel.request("host.stop", {}, "worker.stopped", input.stopTimeoutMs);
        channel.closeInput();
        try {
          await channel.waitForExit(input.stopTimeoutMs);
        } catch (error) {
          channel.terminate();
          throw error;
        }
      },
      terminate(): void {
        channel.terminate();
      },
    };
  }
}
