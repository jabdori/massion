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
}

export class MassionDaemon {
  public state: DaemonState = "starting";
  private closing?: Promise<void>;

  public constructor(private readonly dependencies: MassionDaemonDependencies) {}

  public async start(): Promise<{ readonly host: string; readonly port: number; readonly url: string }> {
    if (this.state !== "starting") throw new Error("Massion daemon은 한 번만 시작할 수 있습니다");
    await this.dependencies.database.version();
    try {
      const address = await this.dependencies.application.start();
      this.state = "ready";
      return address;
    } catch (error) {
      this.state = "failed";
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
      return { database: false, migrations: true };
    }
  }

  public close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.state === "stopped") return Promise.resolve();
    this.state = "draining";
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
      try {
        await this.dependencies.database.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      this.state = "failed";
      throw failure;
    }
    this.state = "stopped";
  }
}
