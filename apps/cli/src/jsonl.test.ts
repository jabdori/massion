import { describe, expect, it } from "vitest";

import { processJsonLines } from "./jsonl.js";

async function* chunks(...values: string[]) {
  for (const value of values) yield Buffer.from(value);
}

describe("headless JSON Lines", () => {
  it("chunk 경계·빈 줄·correlation interleave를 한 줄 envelope로 처리한다", async () => {
    const output: string[] = [];
    await processJsonLines(
      chunks('\n{"correlationId":"a","value":1}\n{"correlation', 'Id":"b","value":2}\n'),
      async (input) => ({
        type: "result",
        correlationId: (input as { correlationId?: unknown }).correlationId,
        data: input,
      }),
      async (line) => {
        output.push(line);
      },
    );
    expect(output).toHaveLength(2);
    expect(output.every((line) => line.endsWith("\n"))).toBe(true);
    expect(output.map((line) => JSON.parse(line).correlationId)).toEqual(["a", "b"]);
  });

  it("malformed line은 구조화 error로 내보내고 1 MiB 초과 line은 종료한다", async () => {
    const output: string[] = [];
    await processJsonLines(
      chunks("{bad}\n"),
      async () => ({}),
      async (line) => {
        output.push(line);
      },
    );
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({ type: "error" });
    await expect(
      processJsonLines(
        chunks(`{"x":"${"x".repeat(1024 * 1024)}"}\n`),
        async () => ({}),
        async () => undefined,
      ),
    ).rejects.toThrow("1 MiB");
  });
});
