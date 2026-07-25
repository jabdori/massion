import type { Readable, Writable } from "node:stream";

import { JsonlFramer, createBridge, type BridgeAdapter } from "./bridge.js";

export interface StdioBridgeOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly error?: Writable;
  readonly exit?: (code: number) => void;
}

export async function runStdioBridge(adapter: BridgeAdapter, options: StdioBridgeOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const framer = new JsonlFramer();
  const bridge = createBridge({
    adapter,
    write: async (line) => {
      await write(output, line);
    },
    log: (message) => void error.write(`${message}\n`),
  });

  for await (const chunk of input) {
    for (const frame of framer.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Uint8Array))) {
      const result =
        frame.kind === "oversized" ? (await bridge.oversized(), "continue") : await bridge.handle(frame.value);
      if (result === "shutdown") {
        input.pause();
        exit(0);
        return;
      }
    }
  }

  for (const frame of framer.end()) {
    if (frame.kind === "oversized") await bridge.oversized();
    else await bridge.handle(frame.value);
  }
}

async function write(output: Writable, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(value, "utf8", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
