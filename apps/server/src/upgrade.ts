import { randomUUID } from "node:crypto";

export type UpgradeStage = "preflight" | "backup" | "migration" | "readiness" | "rollback";

export interface UpgradeReceipt {
  readonly receiptId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: "succeeded" | "failed";
  readonly backupPath?: string;
  readonly backupChecksum?: string;
  readonly migrations: readonly string[];
  readonly failedStage?: UpgradeStage;
  readonly rollbackAttempted: boolean;
  readonly rollbackSucceeded?: boolean;
}

export interface UpgradeOperations {
  readonly fromVersion: string;
  readonly toVersion: string;
  preflight(): Promise<void>;
  backup(): Promise<{ readonly path: string; readonly checksum: string }>;
  migrate(): Promise<readonly string[]>;
  readiness(): Promise<boolean>;
  rollback(): Promise<void>;
}

export class UpgradeFailure extends Error {
  public constructor(
    public readonly receipt: UpgradeReceipt,
    cause: unknown,
  ) {
    super(`Massion upgrade가 ${receipt.failedStage ?? "unknown"} 단계에서 실패했습니다`, { cause });
    this.name = "UpgradeFailure";
  }
}

export async function performUpgrade(operations: UpgradeOperations): Promise<UpgradeReceipt> {
  const receiptId = randomUUID();
  const startedAt = new Date().toISOString();
  let stage: UpgradeStage = "preflight";
  let backup: { readonly path: string; readonly checksum: string } | undefined;
  let migrations: readonly string[] = [];
  try {
    await operations.preflight();
    stage = "backup";
    backup = await operations.backup();
    if (!/^[a-f0-9]{64}$/u.test(backup.checksum)) throw new Error("upgrade backup checksum이 유효하지 않습니다");
    stage = "migration";
    migrations = await operations.migrate();
    stage = "readiness";
    if (!(await operations.readiness())) throw new Error("upgrade readiness가 실패했습니다");
    return {
      receiptId,
      fromVersion: operations.fromVersion,
      toVersion: operations.toVersion,
      startedAt,
      completedAt: new Date().toISOString(),
      outcome: "succeeded",
      backupPath: backup.path,
      backupChecksum: backup.checksum,
      migrations,
      rollbackAttempted: false,
    };
  } catch (cause) {
    let rollbackSucceeded: boolean | undefined;
    if (backup) {
      try {
        await operations.rollback();
        rollbackSucceeded = true;
      } catch {
        rollbackSucceeded = false;
      }
    }
    throw new UpgradeFailure(
      {
        receiptId,
        fromVersion: operations.fromVersion,
        toVersion: operations.toVersion,
        startedAt,
        completedAt: new Date().toISOString(),
        outcome: "failed",
        ...(backup ? { backupPath: backup.path, backupChecksum: backup.checksum } : {}),
        migrations,
        failedStage: stage,
        rollbackAttempted: backup !== undefined,
        ...(rollbackSucceeded === undefined ? {} : { rollbackSucceeded }),
      },
      cause,
    );
  }
}
