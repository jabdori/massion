import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { BridgeAdapter } from "./bridge.js";
import { main } from "./main.js";

function adapter(order: string[]): BridgeAdapter {
  return {
    connect: async () => ({}),
    query: async () => {
      throw new Error("Authorization: Bearer secret-on-stderr");
    },
    command: async () => ({}),
    events: async function* () {},
    executions: async function* () {},
    shutdown: async () => void order.push("adapter"),
  };
}

describe("stdio JSONL runner", () => {
  it("stdout에는 JSONL만 쓰고 shutdown 응답 flush 뒤 종료한다", async () => {
    const order: string[] = [];
    let stdout = "";
    let stderr = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        stdout += String(chunk);
        order.push(stdout.includes('"id":"shutdown-1"') ? "shutdown-flush" : "flush");
        done();
      },
    });
    const error = new Writable({
      write(chunk, _encoding, done) {
        stderr += String(chunk);
        done();
      },
    });
    const input = Readable.from([
      '{"id":"failure-1","method":"query","params":{}}\n',
      '{"id":"hello-1","method":"hello","params":{}}\n',
      '{"id":"shutdown-1","method":"shutdown","params":{}}\n',
      '{"id":"ignored","method":"hello","params":{}}\n',
    ]);

    await main(adapter(order), {
      input,
      output,
      error,
      exit: (code) => order.push(`exit:${String(code)}`),
    });

    const values = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly id: string; readonly ok: boolean });
    expect(values.map(({ id, ok }) => ({ id, ok }))).toEqual([
      { id: "failure-1", ok: false },
      { id: "hello-1", ok: true },
      { id: "shutdown-1", ok: true },
    ]);
    expect(order.slice(-3)).toEqual(["adapter", "shutdown-flush", "exit:0"]);
    expect(`${stdout}\n${stderr}`).not.toContain("secret-on-stderr");
  });
});
