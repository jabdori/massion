import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase } from "@massion/storage";
import type { ServerConnectorProvisioningService } from "@massion/subscriptions";

interface RecoverableServerConnector {
  readonly organization_id: string;
  readonly owner_user_id: string;
  readonly connector_id: string;
}

export interface ServerConnectorStartupRecoveryTransition {
  readonly attempted: number;
  readonly restored: number;
  readonly unavailable: number;
}

export interface ServerConnectorStartupRecoveryFailure {
  readonly category: "owner-context-unavailable" | "health-attestation-failed";
}

export interface ServerConnectorStartupRecoveryOptions {
  readonly bootId?: string;
  readonly maximumConcurrency?: number;
  readonly onTransition?: (transition: ServerConnectorStartupRecoveryTransition) => void | Promise<void>;
  readonly onUnavailable?: (failure: ServerConnectorStartupRecoveryFailure) => void | Promise<void>;
}

function safeBootId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/u.test(value)) throw new Error("시작 복구 Boot ID가 유효하지 않습니다");
  return value;
}

function recoveryCommandId(bootId: string, connector: RecoverableServerConnector): string {
  const digest = createHash("sha256")
    .update("massion-server-connector-startup-v1\0")
    .update(connector.organization_id)
    .update("\0")
    .update(connector.connector_id)
    .digest("hex")
    .slice(0, 32);
  return `startup-${bootId}-${digest}`;
}

export class ServerConnectorStartupRecoveryService {
  private readonly bootId: string;
  private readonly maximumConcurrency: number;
  private readonly onTransition?: ServerConnectorStartupRecoveryOptions["onTransition"];
  private readonly onUnavailable?: ServerConnectorStartupRecoveryOptions["onUnavailable"];
  private started = false;
  private closed = false;
  private healthy = false;

  public constructor(
    private readonly database: Pick<MassionDatabase, "query">,
    private readonly organizations: Pick<OrganizationService, "resolveTenantContext">,
    private readonly connectors: Pick<ServerConnectorProvisioningService, "attestHealth">,
    options: ServerConnectorStartupRecoveryOptions = {},
  ) {
    this.bootId = safeBootId(options.bootId ?? randomUUID());
    this.maximumConcurrency = options.maximumConcurrency ?? 4;
    if (!Number.isSafeInteger(this.maximumConcurrency) || this.maximumConcurrency < 1 || this.maximumConcurrency > 16) {
      throw new Error("서버 Connector 시작 복구 동시성이 유효하지 않습니다");
    }
    this.onTransition = options.onTransition;
    this.onUnavailable = options.onUnavailable;
  }

  public async start(): Promise<void> {
    if (this.closed) throw new Error("종료된 서버 Connector 시작 복구는 다시 시작할 수 없습니다");
    if (this.started) throw new Error("서버 Connector 시작 복구가 이미 시작됐습니다");
    this.started = true;
    this.healthy = false;
    const [records] = await this.database.query<[RecoverableServerConnector[]]>(
      `SELECT organization_id, owner_user_id, connector_id FROM subscription_connector
       WHERE trust_origin = 'server-managed' AND status = 'offline'
       ORDER BY organization_id ASC, connector_id ASC;`,
    );
    let next = 0;
    let restored = 0;
    let unavailable = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const connector = records[index];
        if (!connector) return;
        const outcome = await this.restore(connector);
        if (outcome) restored += 1;
        else unavailable += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.maximumConcurrency, Math.max(1, records.length)) }, async () => {
        await worker();
      }),
    );
    this.healthy = true;
    await this.reportTransition({ attempted: records.length, restored, unavailable });
  }

  public ready(): boolean {
    return this.started && !this.closed && this.healthy;
  }

  public close(): Promise<void> {
    this.closed = true;
    this.healthy = false;
    return Promise.resolve();
  }

  private async restore(connector: RecoverableServerConnector): Promise<boolean> {
    let context: TenantContext;
    try {
      context = await this.organizations.resolveTenantContext(connector.owner_user_id, connector.organization_id);
      if (context.organizationId !== connector.organization_id || context.userId !== connector.owner_user_id) {
        throw new Error("소유자 문맥 계보가 일치하지 않습니다");
      }
    } catch {
      await this.reportUnavailable({ category: "owner-context-unavailable" });
      return false;
    }
    try {
      const recovered = await this.connectors.attestHealth(context, {
        commandId: recoveryCommandId(this.bootId, connector),
        connectorId: connector.connector_id,
      });
      if (recovered.status !== "ready") throw new Error("건강 증명 결과가 준비 상태가 아닙니다");
      return true;
    } catch {
      await this.reportUnavailable({ category: "health-attestation-failed" });
      return false;
    }
  }

  private async reportTransition(transition: ServerConnectorStartupRecoveryTransition): Promise<void> {
    try {
      await this.onTransition?.(transition);
    } catch {
      // 복구 결과 관측 실패가 이미 완료된 상태 전이를 뒤집지 않게 합니다.
    }
  }

  private async reportUnavailable(failure: ServerConnectorStartupRecoveryFailure): Promise<void> {
    try {
      await this.onUnavailable?.(failure);
    } catch {
      // 원인·식별자를 공개하지 않는 집계 관측은 best effort입니다.
    }
  }
}
