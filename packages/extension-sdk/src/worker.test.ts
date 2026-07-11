import { describe, expect, it } from "vitest";

import { createExtensionWorker } from "./worker.js";

async function* lines(values: readonly string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

describe("Extension worker helper", () => {
  it("handshake·health·contribution 호출에 bounded RPC 응답을 쓴다", async () => {
    const output: string[] = [];
    const worker = createExtensionWorker({
      manifestDigest: "a".repeat(64),
      sdkVersion: "1.0.0",
      contributions: ["runtimeTool:echo"],
      handlers: {
        health: async () => ({ status: "healthy" }),
        invoke: async (contribution, input) => ({ contribution, input }),
      },
    });

    await worker.run({
      lines: lines([
        JSON.stringify({
          protocol: "massion.extension.rpc.v1",
          requestId: "handshake-1",
          sequence: 1,
          operation: "host.handshake",
          payload: { nonce: "nonce-1" },
        }),
        JSON.stringify({
          protocol: "massion.extension.rpc.v1",
          requestId: "health-1",
          sequence: 2,
          operation: "health.check",
          payload: {},
        }),
        JSON.stringify({
          protocol: "massion.extension.rpc.v1",
          requestId: "invoke-1",
          sequence: 3,
          operation: "contribution.invoke",
          payload: { contribution: "runtimeTool:echo", input: { text: "안녕" } },
        }),
        JSON.stringify({
          protocol: "massion.extension.rpc.v1",
          requestId: "stop-1",
          sequence: 4,
          operation: "host.stop",
          payload: {},
        }),
      ]),
      writeLine: async (line) => {
        output.push(line);
      },
    });

    expect(output.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        requestId: "handshake-1",
        sequence: 1,
        operation: "worker.handshake",
        payload: {
          nonce: "nonce-1",
          manifestDigest: "a".repeat(64),
          sdkVersion: "1.0.0",
          contributions: ["runtimeTool:echo"],
        },
      }),
      expect.objectContaining({ requestId: "health-1", sequence: 2, operation: "health.result" }),
      expect.objectContaining({
        requestId: "invoke-1",
        sequence: 3,
        operation: "contribution.result",
        payload: { contribution: "runtimeTool:echo", input: { text: "안녕" } },
      }),
      expect.objectContaining({ requestId: "stop-1", sequence: 4, operation: "worker.stopped" }),
    ]);
  });

  it("handshake 전 호출과 선언하지 않은 contribution을 거부한다", async () => {
    const worker = createExtensionWorker({
      manifestDigest: "b".repeat(64),
      sdkVersion: "1.0.0",
      contributions: [],
      handlers: { health: async () => ({ status: "healthy" }), invoke: async () => ({}) },
    });
    await expect(
      worker.run({
        lines: lines([
          JSON.stringify({
            protocol: "massion.extension.rpc.v1",
            requestId: "health-1",
            sequence: 1,
            operation: "health.check",
            payload: {},
          }),
        ]),
        writeLine: async () => undefined,
      }),
    ).rejects.toThrow("handshake");
  });
});
