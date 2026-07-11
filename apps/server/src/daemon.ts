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

export interface MassionDaemonDependencies {
  readonly application: ManagedApplication;
  readonly database: ManagedDatabase;
  readonly shutdownTimeoutMs: number;
  readonly operationalServices?: readonly { start(): Promise<unknown>; close(): Promise<void> }[];
  readonly onState?: (state: DaemonState) => void;
  readonly onReadinessFailure?: (component: "database") => void;
}

export class MassionDaemon {
  public state: DaemonState = "starting";
  private closing?: Promise<void>;
  private lastReadinessFailureAt = 0;

  public constructor(private readonly dependencies: MassionDaemonDependencies) {}

  public async start(): Promise<{ readonly host: string; readonly port: number; readonly url: string }> {
    if (this.state !== "starting") throw new Error("Massion daemon은 한 번만 시작할 수 있습니다");
    await this.dependencies.database.version();
    try {
      const address = await this.dependencies.application.start();
      for (const service of this.dependencies.operationalServices ?? []) await service.start();
      this.setState("ready");
      return address;
    } catch (error) {
      this.setState("failed");
      for (const service of [...(this.dependencies.operationalServices ?? [])].reverse()) {
        await service.close().catch(() => undefined);
      }
      await this.dependencies.application.close().catch(() => undefined);
      await this.dependencies.database.close().catch(() => undefined);
      throw error;
    }
  }

  public async readiness(): Promise<Readonly<Record<string, boolean>>> {
    if (this.state !== "ready") return { database: false, migrations: false };
    try {
      await this.dependencies.database.version();
      return { database: true, migrations: true };
    } catch {
      const now = Date.now();
      if (now - this.lastReadinessFailureAt >= 60_000) {
        this.lastReadinessFailureAt = now;
        this.dependencies.onReadinessFailure?.("database");
      }
      return { database: false, migrations: true };
    }
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: unknown;
    try {
      await Promise.race([
        this.dependencies.application.close(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Massion shutdown deadline을 초과했습니다")),
            this.dependencies.shutdownTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      if (timer) clearTimeout(timer);
      for (const service of [...(this.dependencies.operationalServices ?? [])].reverse()) {
        try {
          await service.close();
        } catch (error) {
          failure ??= error;
        }
      }
      try {
        await this.dependencies.database.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      this.setState("failed");
      throw failure;
    }
    this.setState("stopped");
  }

  private setState(state: DaemonState): void {
    this.state = state;
    this.dependencies.onState?.(state);
  }
}
