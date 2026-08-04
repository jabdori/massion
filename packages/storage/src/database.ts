import { createNodeEngines } from "@surrealdb/node";
import { createRemoteEngines, DateTime, isRetryableConflict, Surreal, type SurrealTransaction } from "surrealdb";

const SUPPORTED_PROTOCOLS = new Set(["mem:", "rocksdb:", "http:", "https:", "ws:", "wss:"]);
const LEGACY_CONFLICT_PREFIX = "Transaction conflict: Write conflict";
const ROLLBACK_TIMEOUT_MS = 1_000;

async function cancelBestEffort(transaction: SurrealTransaction): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      transaction.cancel(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ROLLBACK_TIMEOUT_MS);
        timer.unref();
      }),
    ]).catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isCompatibleRetryableConflict(error: unknown): boolean {
  return (
    isRetryableConflict(error) ||
    (error instanceof Error &&
      error.message.startsWith(LEGACY_CONFLICT_PREFIX) &&
      error.message.endsWith("can be retried"))
  );
}

export function serializeSurrealDateTime(value: unknown): string | undefined {
  try {
    return DateTime.prototype.toISOString.call(value);
  } catch {
    return undefined;
  }
}

export interface DatabaseConfig {
  readonly url: string;
  readonly namespace: string;
  readonly database: string;
  readonly authentication?: {
    readonly username: string;
    readonly password: string;
    readonly scope?: "root" | "database";
  };
}

export interface QueryExecutor {
  query<R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R>;
}

class TransactionExecutor implements QueryExecutor {
  public constructor(private readonly transaction: SurrealTransaction) {}

  public async query<R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> {
    return (await this.transaction.query(surql, bindings)) as R;
  }
}

export class MassionDatabase implements QueryExecutor, AsyncDisposable {
  public constructor(private readonly client: Surreal) {}

  public async query<R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> {
    return (await this.client.query(surql, bindings)) as R;
  }

  public async transaction<T>(operation: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const session = await this.client.forkSession();
      const transaction = await session.beginTransaction();
      try {
        const result = await operation(new TransactionExecutor(transaction));
        await transaction.commit();
        return result;
      } catch (error) {
        await cancelBestEffort(transaction);
        if (!isCompatibleRetryableConflict(error) || attempt >= 3) throw error;
      } finally {
        await session.closeSession();
      }
    }
  }

  public async version(): Promise<string> {
    return (await this.client.version()).version;
  }

  public async exportSql(): Promise<string> {
    return await this.client.export();
  }

  public async importSql(sql: string): Promise<void> {
    await this.client.import(sql);
  }

  public async close(): Promise<void> {
    if (this.client.isConnected) await this.client.close();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export async function createDatabase(config: DatabaseConfig): Promise<MassionDatabase> {
  const url = new URL(config.url);
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`지원하지 않는 SurrealDB URL: ${config.url}`);
  }

  const client = new Surreal({
    engines: {
      ...createRemoteEngines(),
      ...createNodeEngines({ strict: true }),
    },
  });

  try {
    const authentication = config.authentication
      ? config.authentication.scope === "database"
        ? {
            namespace: config.namespace,
            database: config.database,
            username: config.authentication.username,
            password: config.authentication.password,
          }
        : { username: config.authentication.username, password: config.authentication.password }
      : undefined;
    await client.connect(config.url, {
      namespace: config.namespace,
      database: config.database,
      ...(authentication ? { authentication } : {}),
      versionCheck: true,
    });
    return new MassionDatabase(client);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
