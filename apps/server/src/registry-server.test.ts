import { describe, expect, it, vi } from "vitest";

import { RegistryReadHttpServer } from "./registry-server.js";

describe("public Registry server", () => {
  it("GET·HEAD만 npm handler로 전달하고 공개 write를 거부한다", async () => {
    const handle = vi.fn(
      async () =>
        new Response(Buffer.from("artifact"), {
          status: 200,
          headers: { "content-type": "application/octet-stream", etag: '"sha256-test"' },
        }),
    );
    const server = new RegistryReadHttpServer({ handle }, { host: "127.0.0.1", port: 0 });
    const address = await server.start();
    try {
      const get = await fetch(`${address.url}/npm/%40massion-ext%2Fgithub`);
      expect(get.status).toBe(200);
      expect(await get.text()).toBe("artifact");
      expect(get.headers.get("x-content-type-options")).toBe("nosniff");
      const head = await fetch(`${address.url}/npm/%40massion-ext%2Fgithub`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const put = await fetch(`${address.url}/npm/%40massion-ext%2Fgithub`, { method: "PUT", body: "blocked" });
      expect(put.status).toBe(405);
      expect(put.headers.get("allow")).toBe("GET, HEAD");
      expect(handle).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("내부 오류와 npm 밖 경로를 bounded 404로 숨긴다", async () => {
    const server = new RegistryReadHttpServer(
      { handle: async () => await Promise.reject(new Error("database-password=secret")) },
      { host: "127.0.0.1", port: 0 },
    );
    const address = await server.start();
    try {
      expect((await fetch(`${address.url}/unknown`)).status).toBe(404);
      const missing = await fetch(`${address.url}/npm/%40massion-ext%2Fmissing`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toContain("secret");
    } finally {
      await server.close();
    }
  });

  it("동시성과 반복 요청을 503·429와 Retry-After로 backpressure한다", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let now = 1_000;
    const server = new RegistryReadHttpServer(
      {
        handle: async () => {
          await blocked;
          return new Response("ok");
        },
      },
      {
        host: "127.0.0.1",
        port: 0,
        maximumConcurrentRequests: 1,
        rateLimitPerMinute: 1,
        now: () => now,
      },
    );
    const address = await server.start();
    try {
      const first = fetch(`${address.url}/npm/a`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const overloaded = await fetch(`${address.url}/npm/b`);
      expect(overloaded.status).toBe(503);
      expect(overloaded.headers.get("retry-after")).toBe("1");
      release?.();
      expect((await first).status).toBe(200);
      const limited = await fetch(`${address.url}/npm/c`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      now += 60_001;
      expect((await fetch(`${address.url}/npm/d`)).status).toBe(200);
    } finally {
      release?.();
      await server.close();
    }
  });
});
