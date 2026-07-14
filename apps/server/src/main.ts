#!/usr/bin/env node
import { isAbsolute } from "node:path";

import { createDatabase } from "@massion/storage";

import { restoreOperationalBackup, writeOperationalBackup } from "./backup.js";
import { loadDatabaseProvisionConfig, loadDatabaseRestoreConfig, loadServerConfig } from "./config.js";
import { createMassionDaemon, provisionRemoteDatabase } from "./product.js";
import { ShutdownSignalController } from "./signals.js";

function log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event, ...fields })}\n`);
}

function exitAfterLog(code: number, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level: code === 0 ? "info" : "error", event, ...fields })}\n`,
    () => process.exit(code),
  );
}

async function main(): Promise<void> {
  const [command, path, extra] = process.argv.slice(2);
  if (command === "provision") {
    if (path || extra) throw new Error("provision에는 인수가 없어야 합니다");
    await provisionRemoteDatabase(await loadDatabaseProvisionConfig());
    exitAfterLog(0, "server.provision.completed");
    return;
  }
  if (command === "restore") {
    if (!path || extra || !isAbsolute(path)) throw new Error(`${command}에는 절대 파일 경로 하나가 필요합니다`);
    const config = await loadDatabaseRestoreConfig();
    const database = await createDatabase(config);
    try {
      const receipt = await restoreOperationalBackup(database, path);
      exitAfterLog(0, "server.restore.completed", {
        path: receipt.path,
        checksum: receipt.checksum,
        migrations: receipt.migrations.length,
      });
    } finally {
      await database.close();
    }
    return;
  }
  const config = await loadServerConfig();
  if (command === "backup") {
    if (!path || extra || !isAbsolute(path)) throw new Error(`${command}에는 절대 파일 경로 하나가 필요합니다`);
    const database = await createDatabase(config.database);
    try {
      const receipt = await writeOperationalBackup(database, path, process.env.MASSION_VERSION ?? "1.0.0");
      exitAfterLog(0, "server.backup.completed", {
        path: receipt.path,
        checksum: receipt.checksum,
        migrations: receipt.migrations.length,
      });
    } finally {
      await database.close();
    }
    return;
  }
  if (command) throw new Error("지원하지 않는 massion-server command입니다");
  const daemon = await createMassionDaemon(config);
  const address = await daemon.start();
  const signals = new ShutdownSignalController();
  const removeSignalHandlers = (): void => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  };
  const shutdown = (signal: NodeJS.Signals): void => {
    if (signals.receive() === "force") {
      exitAfterLog(1, "server.shutdown.forced", { signal });
      return;
    }
    log("server.shutdown.started", { signal });
    void daemon
      .close()
      .then(() => {
        exitAfterLog(0, "server.shutdown.completed");
      })
      .catch((error: unknown) => {
        exitAfterLog(1, "server.shutdown.failed", { category: error instanceof Error ? error.name : "unknown" });
      })
      .finally(removeSignalHandlers);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  log("server.ready", { mode: config.mode, host: address.host, port: address.port });
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  process.stderr.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "server.start.failed", category: error instanceof Error ? error.name : "unknown" })}\n`,
  );
});
