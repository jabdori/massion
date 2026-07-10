import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { redactSecrets } from "@massion/evidence";

import { normalizeEngineeringPaths } from "./path-lease.js";

export type EngineeringCommandStage = "red" | "green" | "validation";

export interface ConfinedCommandInput {
  readonly stage: EngineeringCommandStage;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface EngineeringCommandEvidence {
  readonly stage: EngineeringCommandStage;
  readonly executable: string;
  readonly argumentsHash: string;
  readonly cwd: string;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly stdoutHash: string;
  readonly stderrHash: string;
  readonly outputExcerpt: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly outputLimited: boolean;
  readonly credentialRedacted: boolean;
}

export interface ConfinedCommandResult {
  readonly evidence: EngineeringCommandEvidence;
  readonly output: string;
}

interface RunnerOptions {
  readonly workspaceRoot: string;
  readonly executables: Readonly<Record<string, string>>;
  readonly environmentAllowlist: readonly string[];
  readonly pathDirectories?: readonly string[];
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxExcerptBytes: number;
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let size = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > maxBytes) break;
    result += character;
    size += bytes;
  }
  return result;
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 이미 종료됐거나 process group 생성 전에 실패한 경우 개별 process 종료로 보완합니다.
    }
  }
  child.kill(signal);
}

export class ConfinedCommandRunner {
  private constructor(
    private readonly workspaceRoot: string,
    private readonly executables: ReadonlyMap<string, string>,
    private readonly environmentAllowlist: ReadonlySet<string>,
    private readonly executionPath: string,
    private readonly limits: {
      readonly maxTimeoutMs: number;
      readonly maxOutputBytes: number;
      readonly maxExcerptBytes: number;
    },
  ) {}

  public static async create(options: RunnerOptions): Promise<ConfinedCommandRunner> {
    if (!Number.isInteger(options.maxTimeoutMs) || options.maxTimeoutMs < 1) {
      throw new Error("Command runner max timeout이 잘못됐습니다");
    }
    if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
      throw new Error("Command runner max output이 잘못됐습니다");
    }
    if (
      !Number.isInteger(options.maxExcerptBytes) ||
      options.maxExcerptBytes < 1 ||
      options.maxExcerptBytes > options.maxOutputBytes
    ) {
      throw new Error("Command runner max excerpt가 잘못됐습니다");
    }
    const workspaceRoot = await realpath(options.workspaceRoot);
    if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("Command workspace root가 directory가 아닙니다");
    const executables = new Map<string, string>();
    for (const [name, path] of Object.entries(options.executables)) {
      if (!/^[a-z][a-z0-9._-]*$/u.test(name) || !isAbsolute(path)) {
        throw new Error("Executable allowlist는 안전한 이름과 absolute path를 사용해야 합니다");
      }
      const executable = await realpath(path);
      const executableStat = await stat(executable);
      if (!executableStat.isFile()) throw new Error(`Allowlist executable이 regular file이 아닙니다: ${name}`);
      await access(executable, constants.X_OK);
      executables.set(name, executable);
    }
    if (executables.size === 0) throw new Error("하나 이상의 executable allowlist가 필요합니다");
    const environmentAllowlist = new Set(options.environmentAllowlist);
    if ([...environmentAllowlist].some((name) => !/^[A-Z_][A-Z0-9_]*$/u.test(name))) {
      throw new Error("Environment allowlist 이름 형식이 잘못됐습니다");
    }
    const pathDirectories = new Set([...executables.values()].map((path) => dirname(path)));
    for (const path of options.pathDirectories ?? []) {
      if (!isAbsolute(path)) throw new Error("Command PATH directory는 absolute path여야 합니다");
      const directory = await realpath(path);
      if (!(await stat(directory)).isDirectory()) throw new Error("Command PATH 항목이 directory가 아닙니다");
      pathDirectories.add(directory);
    }
    return new ConfinedCommandRunner(
      workspaceRoot,
      executables,
      environmentAllowlist,
      [...pathDirectories].join(delimiter),
      {
        maxTimeoutMs: options.maxTimeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        maxExcerptBytes: options.maxExcerptBytes,
      },
    );
  }

  public async run(input: ConfinedCommandInput): Promise<ConfinedCommandResult> {
    const executablePath = this.executables.get(input.executable);
    if (!executablePath) throw new Error(`Command executable allowlist에 없습니다: ${input.executable}`);
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > this.limits.maxTimeoutMs) {
      throw new Error("Command timeout이 policy 범위를 벗어났습니다");
    }
    if (
      !Number.isInteger(input.maxOutputBytes) ||
      input.maxOutputBytes < 1 ||
      input.maxOutputBytes > this.limits.maxOutputBytes
    ) {
      throw new Error("Command output byte 제한이 policy 범위를 벗어났습니다");
    }
    if (input.args.length > 256 || input.args.some((argument) => argument.includes("\0") || argument.length > 16_384)) {
      throw new Error("Command argument 수 또는 길이가 policy 범위를 벗어났습니다");
    }
    const cwd = await this.resolveCwd(input.cwd);
    const environment = this.environment(input.environment);
    const startedAt = performance.now();
    return await new Promise<ConfinedCommandResult>((resolvePromise, reject) => {
      const child = spawn(executablePath, [...input.args], {
        cwd: cwd.absolute,
        env: environment,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdoutHash = createHash("sha256");
      const stderrHash = createHash("sha256");
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;
      let outputLimited = false;
      let timedOut = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const stop = (reason: "timeout" | "output"): void => {
        if (reason === "timeout") timedOut = true;
        if (reason === "output") outputLimited = true;
        killProcessGroup(child, "SIGTERM");
        forceKillTimer ??= setTimeout(() => {
          killProcessGroup(child, "SIGKILL");
        }, 100);
        forceKillTimer.unref();
      };
      const collect = (target: Buffer[], hash: ReturnType<typeof createHash>) => (chunk: Buffer) => {
        hash.update(chunk);
        const remaining = input.maxOutputBytes - capturedBytes;
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining);
          target.push(retained);
          capturedBytes += retained.byteLength;
        }
        if (chunk.byteLength > remaining && !outputLimited) stop("output");
      };
      child.stdout.on("data", collect(stdout, stdoutHash));
      child.stderr.on("data", collect(stderr, stderrHash));
      child.stdin.end();
      const timeout = setTimeout(() => {
        stop("timeout");
      }, input.timeoutMs);
      timeout.unref();

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        reject(new Error(`허용된 executable을 시작하지 못했습니다: ${input.executable}`, { cause: error }));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const stdoutBytes = Buffer.concat(stdout);
        const stderrBytes = Buffer.concat(stderr);
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const stdoutRedaction = redactSecrets(decoder.decode(stdoutBytes));
        const stderrRedaction = redactSecrets(decoder.decode(stderrBytes));
        const redactedStdout = stdoutRedaction.content;
        const redactedStderr = stderrRedaction.content;
        const output = truncateUtf8(
          [redactedStdout, redactedStderr].filter(Boolean).join(redactedStdout && redactedStderr ? "\n" : ""),
          input.maxOutputBytes,
        );
        const outputExcerpt = truncateUtf8(output, this.limits.maxExcerptBytes);
        const evidence: EngineeringCommandEvidence = {
          stage: input.stage,
          executable: input.executable,
          argumentsHash: sha256(JSON.stringify(input.args)),
          cwd: cwd.relative,
          ...(typeof code === "number" ? { exitCode: code } : {}),
          ...(signal ? { signal } : {}),
          stdoutHash: stdoutHash.digest("hex"),
          stderrHash: stderrHash.digest("hex"),
          outputExcerpt,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          timedOut,
          outputLimited,
          credentialRedacted: stdoutRedaction.redactions.length > 0 || stderrRedaction.redactions.length > 0,
        };
        resolvePromise({ evidence, output });
      });
    });
  }

  private async resolveCwd(input: string): Promise<{ readonly relative: string; readonly absolute: string }> {
    let relativePath: string;
    try {
      relativePath = normalizeEngineeringPaths([input])[0] ?? "";
    } catch (error) {
      throw new Error("Command 작업 directory가 안전한 상대 경로가 아닙니다", { cause: error });
    }
    const candidate = resolve(this.workspaceRoot, relativePath === "." ? "" : relativePath);
    const actual = await realpath(candidate);
    if (!within(this.workspaceRoot, actual)) throw new Error("Command 작업 directory가 workspace 밖입니다");
    if (!(await stat(actual)).isDirectory()) throw new Error("Command 작업 directory가 directory가 아닙니다");
    return { relative: relativePath, absolute: actual };
  }

  private environment(requested: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    let bytes = 0;
    for (const [name, value] of Object.entries(requested)) {
      if (!this.environmentAllowlist.has(name)) {
        throw new Error(`Command environment allowlist에 없는 이름입니다: ${name}`);
      }
      if (value.includes("\0")) throw new Error("Command environment 값에 NUL을 쓸 수 없습니다");
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 2;
    }
    if (bytes > 65_536) throw new Error("Command environment 크기가 64 KiB를 초과했습니다");
    return {
      CI: "1",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: this.executionPath,
      ...requested,
    };
  }
}
