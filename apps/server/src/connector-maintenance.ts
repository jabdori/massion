export interface ConnectorExpiryPort {
  expire(): Promise<number>;
}

export interface ConnectorMaintenanceOptions {
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void | Promise<void>;
}

export class ConnectorMaintenanceService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private running = false;
  private closed = false;
  private healthy = false;

  public constructor(
    private readonly expiry: ConnectorExpiryPort,
    private readonly options: ConnectorMaintenanceOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000 || options.intervalMs > 300_000) {
      throw new Error("Connector 유지관리 주기가 유효하지 않습니다");
    }
  }

  public async start(): Promise<void> {
    if (this.closed) throw new Error("종료된 Connector 유지관리 서비스는 다시 시작할 수 없습니다");
    if (this.running) throw new Error("Connector 유지관리 서비스가 이미 실행 중입니다");
    this.running = true;
    try {
      await this.expiry.expire();
      this.healthy = true;
    } catch (error) {
      this.running = false;
      this.healthy = false;
      throw error;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.options.intervalMs);
    this.timer.unref();
  }

  public ready(): boolean {
    return this.running && this.healthy;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.running = false;
    this.closed = true;
    this.healthy = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  private async sweep(): Promise<void> {
    if (!this.running || this.active) return;
    const active = this.expiry
      .expire()
      .then(() => {
        this.healthy = true;
      })
      .catch(async (error: unknown) => {
        this.healthy = false;
        try {
          await this.options.onError?.(error);
        } catch {
          // 오류 보고 수단의 실패가 유지관리 반복을 중단해서는 안 됩니다.
        }
      });
    this.active = active;
    try {
      await active;
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }
}
