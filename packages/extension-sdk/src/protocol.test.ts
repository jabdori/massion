import { describe, expect, it } from "vitest";

import { createRpcFrameParser, validateHandshake } from "./protocol.js";

describe("Extension RPC v1", () => {
  it("연속 sequence의 bounded request frame을 읽는다", () => {
    const parser = createRpcFrameParser({ maxFrameBytes: 1024, maxDepth: 6 });
    expect(
      parser.parse(
        JSON.stringify({
          protocol: "massion.extension.rpc.v1",
          requestId: "request-1",
          sequence: 1,
          operation: "health.check",
          payload: {},
        }),
      ),
    ).toMatchObject({ requestId: "request-1", sequence: 1, operation: "health.check" });
  });

  it("sequence 역행·중복과 stdout 오염을 거부한다", () => {
    const parser = createRpcFrameParser();
    parser.parse(
      JSON.stringify({
        protocol: "massion.extension.rpc.v1",
        requestId: "request-1",
        sequence: 1,
        operation: "health.check",
        payload: {},
      }),
    );
    expect(() =>
      parser.parse(
        JSON.stringify({
          protocol: "massion.extension.rpc.v1",
          requestId: "request-2",
          sequence: 1,
          operation: "health.check",
          payload: {},
        }),
      ),
    ).toThrow("sequence");
    expect(() => createRpcFrameParser().parse("worker started")).toThrow("JSON");
  });

  it("frame byte·깊이·prototype key를 거부한다", () => {
    expect(() => createRpcFrameParser({ maxFrameBytes: 64 }).parse("{" + " ".repeat(100) + "}")).toThrow(
      "byte",
    );
    const polluted =
      '{"protocol":"massion.extension.rpc.v1","requestId":"r","sequence":1,"operation":"health.check","payload":{"__proto__":{"admin":true}}}';
    expect(() => createRpcFrameParser().parse(polluted)).toThrow("prototype");
  });

  it("handshake nonce·manifest digest·contribution exact match를 요구한다", () => {
    const expected = {
      nonce: "one-time-nonce",
      manifestDigest: "a".repeat(64),
      sdkVersion: "1.0.0",
      contributions: ["runtimeTool:github.issue.read"],
    };
    expect(validateHandshake(expected, expected)).toEqual(expected);
    expect(() => validateHandshake({ ...expected, nonce: "wrong" }, expected)).toThrow("nonce");
    expect(() => validateHandshake({ ...expected, contributions: [] }, expected)).toThrow("contribution");
  });
});
