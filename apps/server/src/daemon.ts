export type DaemonState = "starting" | "ready" | "draining" | "stopped" | "failed";

interface ManagedApplication {
  readonly server: { beginDrain(): void };
  start(): Promise<{ readonly host: string; readonly port: number; readonly url: string }>;
  close(): Promise<void>;
}

interface ManagedDatabase {
  version(): Promise<string>;
  close(): Promise<void>;
}

interface ManagedService {
  start(): Promise<unknown>;
  close(): Promise<void>;
}

interface DrainService {
  close(): Promise<void>;
}

export interface MassionDaemonDependencies {
  readonly application: ManagedApplication;
  readonly database: ManagedDatabase;
  readonly shutdownTimeoutMs: number;
  readonly drainServices?: readonly DrainService[];
  readonly beforeListenServices?: readonly ManagedService[];
  readonly afterListenServices?: readonly ManagedService[];
  readonly readinessComponents?: Readonly<Record<string, () => Promise<boolean>>>;
  readonly onState?: (state: DaemonState) => void;
  readonly onReadinessFailure?: (component: string) => void;
}

export class MassionDaemon {
  public state: DaemonState = "starting";
  private closing?: Promise<void>;
  private readonly startedBeforeListenServices: ManagedService[] = [];
  private readonly startedAfterListenServices: ManagedService[] = [];
  private readonly lastReadinessFailureAt = new Map<string, number>();

  public constructor(private readonly dependencies: MassionDaemonDependencies) {}

  public async start(): Promise<{ readonly host: string; readonly port: number; readonly url: string }> {
    if (this.state !== "starting") throw new Error("Massion daemon은 한 번만 시작할 수 있습니다");
    await this.dependencies.database.version();
    try {
      for (const service of this.dependencies.beforeListenServices ?? []) {
        this.startedBeforeListenServices.push(service);
        await service.start();
      }
      const address = await this.dependencies.application.start();
      for (const service of this.dependencies.afterListenServices ?? []) {
        this.startedAfterListenServices.push(service);
        await service.start();
      }
      this.setState("ready");
      return address;
    } catch (error) {
      this.setState("failed");
      for (const service of [...this.startedAfterListenServices].reverse()) {
        await service.close().catch(() => undefined);
      }
      await this.dependencies.application.close().catch(() => undefined);
      for (const service of [...this.startedBeforeListenServices].reverse()) {
        await service.close().catch(() => undefined);
      }
      await this.dependencies.database.close().catch(() => undefined);
      throw error;
    }
  }

  public async readiness(): Promise<Readonly<Record<string, boolean>>> {
    const extra = Object.keys(this.dependencies.readinessComponents ?? {});
    if (this.state !== "ready") {
      return { database: false, migrations: false, ...Object.fromEntries(extra.map((name) => [name, false])) };
    }
    const readiness: Record<string, boolean> = { database: true, migrations: true };
    try {
      await this.dependencies.database.version();
    } catch {
      readiness.database = false;
      this.reportReadinessFailure("database");
    }
    for (const [name, check] of Object.entries(this.dependencies.readinessComponents ?? {})) {
      try {
        readiness[name] = await check();
      } catch {
        readiness[name] = false;
      }
      if (!readiness[name]) this.reportReadinessFailure(name);
    }
    return readiness;
  }

  public close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.state === "stopped") return Promise.resolve();
    this.setState("draining");
    this.dependencies.application.server.beginDrain();
    this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    const deadline = Date.now() + this.dependencies.shutdownTimeoutMs;
    let failure: unknown;

    const closeWithinDeadline = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await this.waitWithinDeadline(operation(), deadline);
      } catch (error) {
        failure ??= error;
      }
    };

    for (const service of this.dependencies.drainServices ?? []) {
      await closeWithinDeadline(async () => {
        await service.close();
      });
    }
    // 수신 후 서비스에는 upgrade된 WebSocket과 복구 작업이 포함될 수 있습니다.
    // 먼저 역순으로 닫아야 HTTP server close가 열린 연결을 기다리며 멈추지 않습니다.
    for (const service of [...this.startedAfterListenServices].reverse()) {
      await closeWithinDeadline(async () => {
        await service.close();
      });
    }
    await closeWithinDeadline(async () => {
      await this.dependencies.application.close();
    });
    for (const service of [...this.startedBeforeListenServices].reverse()) {
      await closeWithinDeadline(async () => {
        await service.close();
      });
    }
    await closeWithinDeadline(async () => {
      await this.dependencies.database.close();
    });

    if (failure) {
      this.setState("failed");
      if (failure instanceof Error) throw failure;
      throw new Error("Massion shutdown에서 알 수 없는 오류가 발생했습니다", { cause: failure });
    }
    this.setState("stopped");
  }

  private async waitWithinDeadline(operation: Promise<void>, deadline: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              reject(new Error("Massion shutdown deadline을 초과했습니다"));
            },
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private setState(state: DaemonState): void {
    this.state = state;
    this.dependencies.onState?.(state);
  }

  private reportReadinessFailure(component: string): void {
    const now = Date.now();
    const previous = this.lastReadinessFailureAt.get(component) ?? 0;
    if (now - previous < 60_000) return;
    this.lastReadinessFailureAt.set(component, now);
    this.dependencies.onReadinessFailure?.(component);
  }
}
