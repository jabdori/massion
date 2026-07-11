import { describe, expect, it } from "vitest";

import { JsonOperationalLogger, MetricRegistry, MetricsHttpServer } from "./telemetry.js";

describe("operations telemetry", () => {
  it("허용된 저카디널리티 label만 Prometheus text로 결정론적으로 내보낸다", () => {
    const metrics = new MetricRegistry({
      massion_operation_total: ["kind", "result"],
      massion_daemon_state: ["state"],
    });
    metrics.increment("massion_operation_total", { kind: "backup", result: "succeeded" });
    metrics.increment("massion_operation_total", { result: "succeeded", kind: "backup" }, 2);
    expect(() => metrics.increment("massion_operation_total", { organizationId: "secret" })).toThrow("label");
    expect(metrics.render()).toBe(
      '# TYPE massion_operation_total counter\nmassion_operation_total{kind="backup",result="succeeded"} 3\n',
    );
  });

  it("별도 HTTP listener가 /metrics GET만 제공한다", async () => {
    const metrics = new MetricRegistry({ massion_daemon_state: ["state"] });
    metrics.increment("massion_daemon_state", { state: "ready" });
    const server = new MetricsHttpServer(metrics, { host: "127.0.0.1", port: 0 });
    const address = await server.start();
    try {
      const response = await fetch(`${address.url}/metrics`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('massion_daemon_state{state="ready"} 1');
      expect((await fetch(`${address.url}/metrics`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${address.url}/unknown`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("구조화 log에서 key·Bearer·URL secret을 제거하고 byte 상한을 적용한다", () => {
    const lines: string[] = [];
    const logger = new JsonOperationalLogger((line) => lines.push(line), { maximumBytes: 512 });
    logger.write("operation.failed", {
      token: "raw-token",
      message: "Bearer abcdefghijklmnopqrstuvwxyz",
      endpoint: "postgres://owner:password@db/internal",
      category: "database-unavailable",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("raw-token");
    expect(lines[0]).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(lines[0]).not.toContain("password");
    expect(lines[0]).toContain("database-unavailable");
  });
});
