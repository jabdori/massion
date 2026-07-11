import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

export interface ConnectorChildHandle {
  stop(timeoutMs: number): Promise<void>;
}

export interface ConnectorProcessLauncher {
  start(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly profileRoot: string;
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<ConnectorChildHandle>;
}

class NodeConnectorChild implements ConnectorChildHandle {
  public constructor(private readonly child: ChildProcess) {}

  public async stop(timeoutMs: number): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit) => this.child.once("exit", () => resolveExit()));
    this.child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
    });
    if ((await Promise.race([exited.then(() => "exited" as const), timeout])) === "timeout") {
      this.child.kill("SIGKILL");
      await exited;
    }
    if (timer) clearTimeout(timer);
  }
}

export class NodeConnectorProcessLauncher implements ConnectorProcessLauncher {
  public async start(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly profileRoot: string;
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<ConnectorChildHandle> {
    await mkdir(input.profileRoot, { recursive: true, mode: 0o700 });
    const child = spawn(input.executable, [...input.args], {
      shell: false,
      cwd: input.profileRoot,
      env: { ...input.environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      child.once("spawn", resolveStart);
      child.once("error", rejectStart);
    });
    return new NodeConnectorChild(child);
  }
}

interface ActiveConnectorProcess {
  readonly connectorId: string;
  readonly accountId: string;
  readonly child: ConnectorChildHandle;
  lastHeartbeatAt: number;
}

export interface ConnectorProcessSupervisorOptions {
  readonly executableAllowlist: Readonly<Record<string, string>>;
  readonly profileRoot: string;
  readonly heartbeatTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly now?: () => number;
  readonly onOffline?: (connectorId: string) => void | Promise<void>;
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

export class ConnectorProcessSupervisor {
  private readonly active = new Map<string, ActiveConnectorProcess>();
  private readonly now: () => number;

  public constructor(
    private readonly launcher: ConnectorProcessLauncher,
    private readonly options: ConnectorProcessSupervisorOptions,
  ) {
    if (
      !Number.isSafeInteger(options.heartbeatTimeoutMs) ||
      options.heartbeatTimeoutMs < 1_000 ||
      options.heartbeatTimeoutMs > 300_000 ||
      !Number.isSafeInteger(options.stopTimeoutMs) ||
      options.stopTimeoutMs < 100 ||
      options.stopTimeoutMs > 60_000
    ) {
      throw new Error("Connector process supervision 설정이 유효하지 않습니다");
    }
    this.now = options.now ?? Date.now;
  }

  public async start(input: {
    readonly connectorId: string;
    readonly accountId: string;
    readonly executableId: string;
    readonly args: readonly string[];
  }): Promise<void> {
    const connectorId = identifier(input.connectorId, "Connector ID");
    const accountId = identifier(input.accountId, "계정 ID");
    if (this.active.has(connectorId)) throw new Error("Connector process가 이미 실행 중입니다");
    const executable = this.options.executableAllowlist[input.executableId];
    if (!executable) throw new Error("허용되지 않은 Connector 실행 파일입니다");
    if (!executable.startsWith("/") || input.args.length > 64 || input.args.some((arg) => arg.includes("\0"))) {
      throw new Error("Connector process 실행 입력이 유효하지 않습니다");
    }
    const root = resolve(this.options.profileRoot);
    const profileRoot = resolve(root, accountId);
    if (!profileRoot.startsWith(`${root}${sep}`)) throw new Error("Connector profile 경로가 유효하지 않습니다");
    const child = await this.launcher.start({
      executable,
      args: input.args,
      profileRoot,
      environment: {
        MASSION_CONNECTOR_ID: connectorId,
        MASSION_CONNECTOR_ACCOUNT_ID: accountId,
        MASSION_CONNECTOR_PROFILE_ROOT: profileRoot,
      },
    });
    this.active.set(connectorId, { connectorId, accountId, child, lastHeartbeatAt: this.now() });
  }

  public heartbeat(connectorId: string): void {
    const process = this.active.get(identifier(connectorId, "Connector ID"));
    if (!process) throw new Error("실행 중인 Connector process가 없습니다");
    process.lastHeartbeatAt = this.now();
  }

  public async expire(): Promise<number> {
    const expired = [...this.active.values()].filter(
      (process) => this.now() - process.lastHeartbeatAt > this.options.heartbeatTimeoutMs,
    );
    for (const process of expired) {
      this.active.delete(process.connectorId);
      await process.child.stop(this.options.stopTimeoutMs);
      await this.options.onOffline?.(process.connectorId);
    }
    return expired.length;
  }

  public async shutdown(): Promise<void> {
    const processes = [...this.active.values()];
    this.active.clear();
    await Promise.all(processes.map(async (process) => await process.child.stop(this.options.stopTimeoutMs)));
  }
}
