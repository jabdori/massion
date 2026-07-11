export interface JsonlEnvelope {
  readonly type: string;
  readonly correlationId?: string;
  readonly [key: string]: unknown;
}

export async function processJsonLines(
  source: AsyncIterable<Uint8Array>,
  handle: (input: unknown) => Promise<JsonlEnvelope | unknown>,
  write: (line: string) => Promise<void>,
): Promise<void> {
  let pending = Buffer.alloc(0);
  const consume = async (line: Buffer): Promise<void> => {
    if (line.length === 0 || line.toString("utf8").trim() === "") return;
    if (line.length > 1024 * 1024) throw new Error("JSON Lines 한 줄 1 MiB 상한을 초과했습니다");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      const input = JSON.parse(text) as unknown;
      await write(`${JSON.stringify(await handle(input))}\n`);
    } catch (error) {
      await write(
        `${JSON.stringify({ schemaVersion: "massion.cli.jsonl.v1", type: "error", error: { category: "validation", message: error instanceof Error ? error.message : "JSON line 오류" } })}\n`,
      );
    }
  };
  for await (const chunk of source) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (pending.length > 1024 * 1024 && !pending.includes(0x0a))
      throw new Error("JSON Lines 한 줄 1 MiB 상한을 초과했습니다");
    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      await consume(pending.subarray(0, newline));
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
  }
  if (pending.length > 0) await consume(pending);
}

export async function writeWithBackpressure(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error("JSON Lines output 4 MiB 상한을 초과했습니다");
  if (stream.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}
