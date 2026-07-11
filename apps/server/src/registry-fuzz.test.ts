import { describe, expect, it } from "vitest";

import { RegistryReadHttpServer } from "./registry-server.js";

function generator(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value;
  };
}

describe("Registry HTTP deterministic fuzz", () => {
  it("malformed path·method corpus가 process crash·과대 응답 없이 종료한다", async () => {
    const next = generator(22);
    const alphabet = "%/@._-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const server = new RegistryReadHttpServer(
      { handle: async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }) },
      { host: "127.0.0.1", port: 0, rateLimitPerMinute: 10_000 },
    );
    const address = await server.start();
    try {
      for (let index = 0; index < 300; index += 1) {
        const length = next() % 128;
        let suffix = "";
        for (let cursor = 0; cursor < length; cursor += 1) suffix += alphabet[next() % alphabet.length];
        const method = ["GET", "HEAD", "PUT", "DELETE"][next() % 4]!;
        const response = await fetch(`${address.url}/npm/${suffix}`, { method });
        expect([200, 404, 405]).toContain(response.status);
        expect((await response.arrayBuffer()).byteLength).toBeLessThanOrEqual(1024);
      }
    } finally {
      await server.close();
    }
  });
});
