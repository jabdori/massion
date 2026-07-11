#!/usr/bin/env node
import { loadServerConfig } from "./config.js";
import { createMassionDaemon } from "./product.js";

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
  const config = await loadServerConfig();
  const daemon = await createMassionDaemon(config);
  const address = await daemon.start();
  log("server.ready", { mode: config.mode, host: address.host, port: address.port });
  let signalCount = 0;
  const removeSignalHandlers = (): void => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  };
  const shutdown = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    if (signalCount > 1) {
      log("server.shutdown.forced", { signal });
      process.exit(1);
    }
    log("server.shutdown.started", { signal });
    void daemon
      .close()
      .then(() => exitAfterLog(0, "server.shutdown.completed"))
      .catch((error: unknown) => {
        exitAfterLog(1, "server.shutdown.failed", { category: error instanceof Error ? error.name : "unknown" });
      })
      .finally(removeSignalHandlers);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  process.stderr.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "server.start.failed", category: error instanceof Error ? error.name : "unknown" })}\n`,
  );
});
