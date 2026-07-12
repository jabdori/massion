import { randomUUID } from "node:crypto";

import type { MassionDatabase, QueryExecutor } from "@massion/storage";
import type { ConnectorHeartbeat, ConnectorRegistry } from "@massion/subscriptions";

import type { ConnectorHandshakeNonceClaims, ConnectorPublicKeyDirectory } from "./connector-channel.js";
import type { ConnectorChannelLifecycle } from "./connector-websocket.js";

interface PublicKeyRecord {
  readonly public_key?: string;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return normalized;
}

function requireHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error("Handshake nonce hash가 유효하지 않습니다");
  return normalized;
}

function requireDate(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}이 유효하지 않습니다`);
  return parsed;
}

/**
 * 장치 채널의 인증·재전송 방지·연결 수명을 Subscription 정본에 연결합니다.
 */
export class ConnectorChannelPersistence
  implements ConnectorPublicKeyDirectory, ConnectorHandshakeNonceClaims, ConnectorChannelLifecycle
{
  private readonly now: () => Date;

  public constructor(
    private readonly database: MassionDatabase,
    private readonly registry: Pick<ConnectorRegistry, "heartbeat" | "expire">,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async findPublicKey(identity: {
    readonly organizationId: string;
    readonly connectorId: string;
  }): Promise<string | undefined> {
    const organizationId = requireIdentifier(identity.organizationId, "조직 ID");
    const connectorId = requireIdentifier(identity.connectorId, "Connector ID");
    const [records] = await this.database.query<[PublicKeyRecord[]]>(
      `SELECT public_key FROM subscription_connector
       WHERE organization_id = $organization_id AND connector_id = $connector_id
         AND location = 'edge' AND trust_origin = 'edge-device'
         AND status IN ['enrolling', 'ready', 'offline'] AND public_key != NONE
       LIMIT 1;`,
      { organization_id: organizationId, connector_id: connectorId },
    );
    const publicKey = records[0]?.public_key;
    return typeof publicKey === "string" && publicKey.length > 0 ? publicKey : undefined;
  }

  public async claim(input: {
    readonly organizationId: string;
    readonly connectorId: string;
    readonly nonceHash: string;
    readonly observedAt: string;
    readonly claimedAt: string;
  }): Promise<boolean> {
    const organizationId = requireIdentifier(input.organizationId, "조직 ID");
    const connectorId = requireIdentifier(input.connectorId, "Connector ID");
    const nonceHash = requireHash(input.nonceHash);
    const observedAt = requireDate(input.observedAt, "Handshake 관측 시각");
    const claimedAt = requireDate(input.claimedAt, "Handshake 선점 시각");
    const parameters = {
      organization_id: organizationId,
      connector_id: connectorId,
      nonce_hash: nonceHash,
    };

    try {
      return await this.database.transaction(async (tx) => {
        if (await this.nonceExists(tx, parameters)) return false;
        await tx.query(
          `CREATE subscription_connector_nonce CONTENT {
            nonce_id: $nonce_id, organization_id: $organization_id, connector_id: $connector_id,
            nonce_hash: $nonce_hash, observed_at: $observed_at, created_at: $created_at
          };`,
          { ...parameters, nonce_id: randomUUID(), observed_at: observedAt, created_at: claimedAt },
        );
        return true;
      });
    } catch (error) {
      // 동시에 들어온 두 transaction 중 하나가 unique index에서 패배할 수 있습니다.
      // 실제 정본에 같은 nonce가 생겼을 때만 재전송으로 처리하고 다른 DB 오류는 숨기지 않습니다.
      if (await this.nonceExists(this.database, parameters)) return false;
      throw error;
    }
  }

  public async connected(input: {
    readonly organizationId: string;
    readonly connectorId: string;
    readonly observedAt: string;
  }): Promise<void> {
    requireDate(input.observedAt, "Connector 연결 시각");
    if (!(await this.findPublicKey(input))) throw new Error("연결 가능한 Edge Connector를 찾을 수 없습니다");
  }

  public async heartbeat(input: ConnectorHeartbeat): Promise<void> {
    await this.registry.heartbeat(input);
  }

  public async disconnected(input: { readonly organizationId: string; readonly connectorId: string }): Promise<void> {
    const organizationId = requireIdentifier(input.organizationId, "조직 ID");
    const connectorId = requireIdentifier(input.connectorId, "Connector ID");
    const now = this.now();
    await this.database.transaction(async (tx) => {
      await tx.query(
        `UPDATE subscription_connector SET status = 'offline', updated_at = $now
         WHERE organization_id = $organization_id AND connector_id = $connector_id
           AND location = 'edge' AND trust_origin = 'edge-device' AND status = 'ready';
         UPDATE subscription_account SET status = 'offline', version += 1, updated_at = $now
         WHERE organization_id = $organization_id AND connector_id = $connector_id AND status = 'active';`,
        { organization_id: organizationId, connector_id: connectorId, now },
      );
    });
  }

  public async expire(): Promise<number> {
    return await this.registry.expire();
  }

  private async nonceExists(
    executor: QueryExecutor,
    input: { readonly organization_id: string; readonly connector_id: string; readonly nonce_hash: string },
  ): Promise<boolean> {
    const [records] = await executor.query<[Array<{ nonce_id: string }>]>(
      `SELECT nonce_id FROM subscription_connector_nonce
       WHERE organization_id = $organization_id AND connector_id = $connector_id AND nonce_hash = $nonce_hash
       LIMIT 1;`,
      input,
    );
    return records[0] !== undefined;
  }
}
