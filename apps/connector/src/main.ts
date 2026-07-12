#!/usr/bin/env node

import { connectorCliFailureMessage, executeConnectorCli, parseConnectorCli } from "./cli.js";

const controller = new AbortController();
const stop = (): void => {
  controller.abort("process signal");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await executeConnectorCli(parseConnectorCli(process.argv.slice(2)), { signal: controller.signal });
} catch (error) {
  process.stderr.write(`${connectorCliFailureMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
