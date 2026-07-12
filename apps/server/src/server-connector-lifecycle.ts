import type { MassionDatabase } from "@massion/storage";

export interface ServerConnectorLifecycleTransition {
  readonly phase: "startup" | "shutdown";
  readonly connectorCount: number;
  readonly accountCount: number;
}

export interface ServerConnectorLifecycleOptions {
  readonly now?: () => Date;
  readonly onTransition?: (transition: ServerConnectorLifecycleTransition) => void | Promise<void>;
}

/**
 * 이 서버 process가 직접 소유하는 구독 Runtime의 생존 상태를 데이터베이스 정본과 맞춥니다.
 */
export class ServerConnectorLifecycleService {
  private readonly now: () => Date;
  private readonly onTransition?: ServerConnectorLifecycleOptions["onTransition"];
  private started = false;
  private closed = false;
  private healthy = false;
  private closing?: Promise<void>;

  public constructor(
    private readonly database: MassionDatabase,
    options: ServerConnectorLifecycleOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onTransition = options.onTransition;
  }

  public async start(): Promise<void> {
    if (this.closed) throw new Error("종료된 서버 Connector 수명주기 서비스는 다시 시작할 수 없습니다");
    if (this.started) throw new Error("서버 Connector 수명주기 서비스가 이미 시작됐습니다");
    this.started = true;
    this.healthy = false;
    const transition = await this.moveOwnedRuntimeOffline("startup");
    this.healthy = true;
    await this.report(transition);
  }

  public ready(): boolean {
    return this.started && !this.closed && this.healthy;
  }

  public async close(): Promise<void> {
    if (this.closing) {
      await this.closing;
      return;
    }
    this.closed = true;
    this.healthy = false;
    this.closing = (async () => {
      if (!this.started) return;
      const transition = await this.moveOwnedRuntimeOffline("shutdown");
      await this.report(transition);
    })();
    await this.closing;
  }

  private async moveOwnedRuntimeOffline(
    phase: ServerConnectorLifecycleTransition["phase"],
  ): Promise<ServerConnectorLifecycleTransition> {
    const now = this.now();
    const counts = await this.database.transaction(async (transaction) => {
      const [connectors] = await transaction.query<[Array<{ connector_id: string }>]>(
        `UPDATE subscription_connector SET status = 'offline', updated_at = $now
         WHERE trust_origin = 'server-managed' AND status = 'ready'
         RETURN BEFORE;`,
        { now },
      );
      const [accounts] = await transaction.query<[Array<{ account_id: string }>]>(
        `UPDATE subscription_account SET status = 'offline', version += 1, updated_at = $now
         WHERE status = 'active' AND [organization_id, connector_id] IN (
           SELECT VALUE [organization_id, connector_id] FROM subscription_connector
           WHERE trust_origin = 'server-managed'
         )
         RETURN BEFORE;`,
        { now },
      );
      return { connectorCount: connectors.length, accountCount: accounts.length };
    });
    return { phase, ...counts };
  }

  private async report(transition: ServerConnectorLifecycleTransition): Promise<void> {
    try {
      await this.onTransition?.(transition);
    } catch {
      // 안전한 offline 전환이 끝난 뒤 관측 보고 실패가 서버 시작·종료를 뒤집지 않게 합니다.
    }
  }
}
