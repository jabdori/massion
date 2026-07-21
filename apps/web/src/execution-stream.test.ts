import { describe, expect, it } from "vitest";

import { accumulateExecutionDelta, decodeWebExecutionDelta, parseExecutionDeltaFrames } from "./execution-stream.js";

describe("Web 실행 델타", () => {
  it("output-text를 누적하고 tool-call은 마커 줄로 남기며 finish에서 정리한다", () => {
    let stream = accumulateExecutionDelta(undefined, {
      executionId: "execution-1",
      agentHandle: "representative",
      sequence: 1,
      kind: "output-text",
      text: "환불",
    });
    stream = accumulateExecutionDelta(stream, {
      executionId: "execution-1",
      agentHandle: "representative",
      sequence: 2,
      kind: "tool-call",
      toolName: "repo-search",
    });
    expect(stream?.text).toContain("환불");
    expect(stream?.text).toContain("▸ 도구 실행: repo-search");

    stream = accumulateExecutionDelta(stream, {
      executionId: "execution-1",
      agentHandle: "representative",
      sequence: 3,
      kind: "lifecycle",
      summary: "finish",
    });
    expect(stream).toBeUndefined();
  });

  it("execution-delta frame만 파싱하고 나머지는 rest로 보존한다", () => {
    const input =
      ": heartbeat 1\n\n" +
      'event: execution-delta\ndata: {"executionId":"execution-1","agentHandle":"representative","sequence":1,"kind":"output-text","text":"API"}\n\n' +
      "event: execution-delta\ndata: {깨진 JSON}\n\n" +
      'event: execution-delta\ndata: {"partial":';
    const parsed = parseExecutionDeltaFrames(input);
    expect(parsed.deltas).toHaveLength(1);
    expect(parsed.deltas[0]).toMatchObject({ kind: "output-text", text: "API" });
    expect(parsed.rest).toContain("partial");
  });

  it("손상된 델타는 undefined로 거른다", () => {
    expect(decodeWebExecutionDelta({ executionId: 1 })).toBeUndefined();
    expect(decodeWebExecutionDelta(null)).toBeUndefined();
    expect(
      decodeWebExecutionDelta({
        executionId: "execution-1",
        agentHandle: "representative",
        sequence: 1,
        kind: "output-text",
        text: "ok",
      }),
    ).toBeDefined();
  });
});
