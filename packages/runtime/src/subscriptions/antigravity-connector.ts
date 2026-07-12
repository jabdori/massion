import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, isAbsolute } from "node:path";

import type { TenantContext } from "@massion/identity";

import type {
  SubscriptionAgentAdapter,
  SubscriptionAgentInput,
  SubscriptionAgentResult,
  SubscriptionAgentResumeInput,
} from "./agent-runtime.js";

export type CliProcessResult =
  | { readonly outcome: "exited"; readonly exitCode: number; readonly stdout: string }
  | {
      readonly outcome: "cancelled" | "timed-out" | "output-limit" | "failed-to-start";
      readonly stdout: string;
    };

export interface CliProcessHandle {
  readonly result: Promise<CliProcessResult>;
  cancel(): Promise<void>;
}

export interface CliProcessRunner {
  start(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly timeoutMs: number;
    readonly maxStdoutBytes: number;
    readonly maxStderrBytes: number;
  }): CliProcessHandle;
}

type ForcedProcessOutcome = Exclude<CliProcessResult["outcome"], "exited">;

class NodeCliProcessHandle implements CliProcessHandle {
  public readonly result: Promise<CliProcessResult>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdout: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private forcedOutcome: ForcedProcessOutcome | undefined;
  private settled = false;
  private resolveResult: ((result: CliProcessResult) => void) | undefined;
  private readonly timeout: NodeJS.Timeout;
  private killTimeout: NodeJS.Timeout | undefined;

  public constructor(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly timeoutMs: number;
    readonly maxStdoutBytes: number;
    readonly maxStderrBytes: number;
  }) {
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
    this.child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: { ...input.env },
      shell: input.shell,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.end();
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.captureStdout(chunk, input.maxStdoutBytes);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > input.maxStderrBytes) this.force("output-limit");
    });
    this.child.once("error", () => {
      this.finish({ outcome: "failed-to-start", stdout: this.stdoutText() });
    });
    this.child.once("close", (exitCode) => {
      if (this.forcedOutcome) {
        this.finish({ outcome: this.forcedOutcome, stdout: this.stdoutText() });
        return;
      }
      this.finish({ outcome: "exited", exitCode: exitCode ?? 1, stdout: this.stdoutText() });
    });
    this.timeout = setTimeout(() => {
      this.force("timed-out");
    }, input.timeoutMs);
    this.timeout.unref();
  }

  public async cancel(): Promise<void> {
    if (!this.settled) this.force("cancelled");
    await this.result;
  }

  private captureStdout(chunk: Buffer, maximum: number): void {
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > maximum) {
      this.force("output-limit");
      return;
    }
    this.stdout.push(chunk);
  }

  private force(outcome: ForcedProcessOutcome): void {
    if (this.settled || this.forcedOutcome) return;
    this.forcedOutcome = outcome;
    this.terminate("SIGTERM");
    this.killTimeout = setTimeout(() => {
      if (!this.settled) this.terminate("SIGKILL");
    }, 2_000);
    this.killTimeout.unref();
  }

  private terminate(signal: NodeJS.Signals): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (process.platform !== "win32" && this.child.pid) {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        // 프로세스 그룹이 이미 끝났다면 개별 자식 종료를 시도합니다.
      }
    }
    this.child.kill(signal);
  }

  private stdoutText(): string {
    return Buffer.concat(this.stdout).toString("utf8");
  }

  private finish(result: CliProcessResult): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timeout);
    if (this.killTimeout) clearTimeout(this.killTimeout);
    this.resolveResult?.(result);
    this.resolveResult = undefined;
  }
}

export class NodeCliProcessRunner implements CliProcessRunner {
  public start(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly timeoutMs: number;
    readonly maxStdoutBytes: number;
    readonly maxStderrBytes: number;
  }): CliProcessHandle {
    return new NodeCliProcessHandle(input);
  }
}

export type AntigravityDoctorResult =
  | { readonly status: "ready"; readonly version: string }
  | { readonly status: "incompatible"; readonly version: string; readonly minimumVersion: "1.1.1" }
  | { readonly status: "unavailable"; readonly reason: string };

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly display: string;
}

const MINIMUM_VERSION = { major: 1, minor: 1, patch: 1, display: "1.1.1" } as const;
const ONE_SHOT_PREFIX = "antigravity-one-shot:";
const NODE_PROCESS_RUNNER = new NodeCliProcessRunner();

function semanticVersion(output: string): SemanticVersion | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(output.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch, display: `${String(major)}.${String(minor)}.${String(patch)}` };
}

function atLeast(version: SemanticVersion, minimum: SemanticVersion): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

function processEnvironment(input: SubscriptionAgentInput): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL"]) {
    const value = input.environment[key];
    if (value !== undefined) environment[key] = value;
  }
  if (!environment.HOME && !environment.USERPROFILE) {
    throw new Error("Antigravity CLI 단일 OS 계정의 home 환경이 필요합니다");
  }
  return environment;
}

export class AntigravityCliConnector implements SubscriptionAgentAdapter {
  private readonly active = new Map<string, CliProcessHandle>();
  private doctorPromise: Promise<AntigravityDoctorResult> | undefined;

  public constructor(
    private readonly options: {
      readonly executable: string;
      readonly model?: string;
      readonly sandbox?: boolean;
      readonly timeoutMs?: number;
    },
    private readonly runner: CliProcessRunner = NODE_PROCESS_RUNNER,
  ) {}

  public doctor(): Promise<AntigravityDoctorResult> {
    this.doctorPromise ??= this.inspectVersion();
    return this.doctorPromise;
  }

  public async execute(_context: TenantContext, input: SubscriptionAgentInput): Promise<SubscriptionAgentResult> {
    if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.profileRoot)) {
      throw new Error("Antigravity workspace와 account locator는 절대 경로여야 합니다");
    }
    if (!isAbsolute(this.options.executable)) throw new Error("Antigravity CLI 실행 파일은 절대 경로여야 합니다");
    if (input.allowedTools.length > 0 || input.disallowedTools.length > 0) {
      throw new Error("Antigravity CLI는 Massion 요청별 도구 정책을 지원하지 않습니다");
    }
    if (input.sessionId?.startsWith(ONE_SHOT_PREFIX)) {
      throw new Error("Antigravity one-shot session ID는 재개할 수 없습니다");
    }
    const doctor = await this.doctor();
    if (doctor.status !== "ready") {
      throw new Error(
        doctor.status === "incompatible"
          ? `Antigravity CLI ${doctor.version}은 지원되지 않습니다. ${doctor.minimumVersion} 이상이 필요합니다`
          : `Antigravity CLI를 사용할 수 없습니다: ${doctor.reason}`,
      );
    }
    const args = [
      ...(this.options.sandbox === false ? [] : ["--sandbox"]),
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(input.sessionId ? ["--conversation", input.sessionId] : []),
      "--print",
      input.prompt,
    ];
    const handle = this.runner.start({
      executable: this.options.executable,
      args,
      cwd: input.workspaceRoot,
      env: processEnvironment(input),
      shell: false,
      timeoutMs: this.options.timeoutMs ?? 300_000,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    this.active.set(input.executionId, handle);
    try {
      const result = await handle.result;
      const sessionId = input.sessionId ?? `${ONE_SHOT_PREFIX}${input.executionId}`;
      if (result.outcome === "cancelled") {
        return { outcome: "cancelled", executionId: input.executionId, sessionId };
      }
      if (result.outcome !== "exited") {
        return {
          outcome: "failed",
          executionId: input.executionId,
          sessionId,
          category: `antigravity-${result.outcome}`,
          retryable: result.outcome !== "failed-to-start",
        };
      }
      if (result.exitCode !== 0) {
        return {
          outcome: "failed",
          executionId: input.executionId,
          sessionId,
          category: `antigravity-exit-${String(result.exitCode)}`,
          retryable: true,
        };
      }
      const value = result.stdout.trim();
      if (!value) {
        return {
          outcome: "failed",
          executionId: input.executionId,
          sessionId,
          category: "antigravity-empty-output",
          retryable: true,
        };
      }
      return { outcome: "completed", executionId: input.executionId, sessionId, value };
    } finally {
      if (this.active.get(input.executionId) === handle) this.active.delete(input.executionId);
    }
  }

  public async resume(
    context: TenantContext,
    input: SubscriptionAgentInput,
    approval: SubscriptionAgentResumeInput,
  ): Promise<SubscriptionAgentResult> {
    if (!approval.approved) {
      return { outcome: "cancelled", executionId: input.executionId, sessionId: approval.sessionId };
    }
    return await this.execute(context, { ...input, sessionId: approval.sessionId });
  }

  public async cancel(_context: TenantContext, executionId: string): Promise<void> {
    const handle = this.active.get(executionId);
    if (!handle) return;
    await handle.cancel();
    if (this.active.get(executionId) === handle) this.active.delete(executionId);
  }

  private async inspectVersion(): Promise<AntigravityDoctorResult> {
    if (!isAbsolute(this.options.executable)) {
      return { status: "unavailable", reason: "실행 파일 절대 경로가 아닙니다" };
    }
    const handle = this.runner.start({
      executable: this.options.executable,
      args: ["--version"],
      cwd: dirname(this.options.executable),
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      timeoutMs: 5_000,
      maxStdoutBytes: 4 * 1024,
      maxStderrBytes: 4 * 1024,
    });
    const result = await handle.result;
    if (result.outcome !== "exited" || result.exitCode !== 0) {
      return { status: "unavailable", reason: `version probe ${result.outcome}` };
    }
    const version = semanticVersion(result.stdout);
    if (!version) return { status: "unavailable", reason: "version 형식을 확인할 수 없습니다" };
    if (!atLeast(version, MINIMUM_VERSION)) {
      return { status: "incompatible", version: version.display, minimumVersion: MINIMUM_VERSION.display };
    }
    return { status: "ready", version: version.display };
  }
}
