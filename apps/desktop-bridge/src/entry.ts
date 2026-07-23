#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createProductionApplicationAdapter } from "./application-adapter.js";
import type { BridgeAdapter } from "./bridge.js";
import { main } from "./main.js";
import { prepareDesktopRuntimeEnvironment } from "./runtime-staging.js";
import type { StdioBridgeOptions } from "./stdio.js";

export interface EntryOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly prepareEnvironment?: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<NodeJS.ProcessEnv>;
  readonly createAdapter?: (environment: Readonly<Record<string, string | undefined>>) => BridgeAdapter;
  readonly stdio?: StdioBridgeOptions;
}

export async function runEntry(options: EntryOptions = {}): Promise<void> {
  const environment = await (options.prepareEnvironment ?? prepareDesktopRuntimeEnvironment)(
    options.environment ?? process.env,
  );
  const adapter = (options.createAdapter ?? createProductionApplicationAdapter)(environment);
  await main(adapter, options.stdio);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runEntry().catch(() => {
    process.stderr.write("Massion desktop bridge를 시작하지 못했습니다\n", () => process.exit(1));
  });
}
