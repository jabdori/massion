import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export function percentile(values, quantile) {
  if (values.length === 0) throw new Error("percentile 표본이 비어 있습니다");
  if (!(quantile > 0 && quantile <= 1)) throw new Error("percentile quantile이 유효하지 않습니다");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("부하 검증 port를 할당하지 못했습니다");
  await new Promise((resolvePromise, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    }),
  );
  return address.port;
}

async function main() {
  const root = resolve(fileURLToPath(new globalThis.URL("..", import.meta.url)));
  const directory = await mkdtemp(resolve(tmpdir(), "massion-hardening-load-"));
  const [httpPort, metricsPort, registryPort] = await Promise.all([reservePort(), reservePort(), reservePort()]);
  const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      MASSION_TOKEN_KEY: globalThis.Buffer.alloc(32, 31).toString("base64url"),
      MASSION_CREDENTIAL_KEY: globalThis.Buffer.alloc(32, 32).toString("base64url"),
      MASSION_SOFTWARE_WORKSPACE_ROOT: resolve(directory, "workspaces"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_HTTP_PORT: String(httpPort),
      MASSION_METRICS_PORT: String(metricsPort),
      MASSION_REGISTRY_PORT: String(registryPort),
      MASSION_REGISTRY_ARTIFACT_ROOT: directory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const lines = createInterface({ input: child.stdout });
  try {
    await new Promise((resolvePromise, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error("daemon ready 대기 시간을 초과했습니다")), 20_000);
      child.once("exit", (code, signal) => {
        globalThis.clearTimeout(timer);
        reject(new Error(`daemon이 준비 전에 종료됐습니다: ${JSON.stringify({ code, signal })}`));
      });
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.event === "server.ready") {
          globalThis.clearTimeout(timer);
          resolvePromise();
        }
      });
    });
    const durations = [];
    let failures = 0;
    const total = 500;
    const concurrency = 32;
    for (let offset = 0; offset < total; offset += concurrency) {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, total - offset) }, async () => {
          const started = globalThis.performance.now();
          const response = await globalThis.fetch(`http://127.0.0.1:${String(httpPort)}/health/live`);
          durations.push(globalThis.performance.now() - started);
          if (response.status !== 200) failures += 1;
          await response.arrayBuffer();
        }),
      );
    }
    const p95Ms = percentile(durations, 0.95);
    if (failures !== 0) throw new Error(`부하 검증 실패 응답이 ${String(failures)}건입니다`);
    if (p95Ms > 500) throw new Error(`부하 검증 p95 ${p95Ms.toFixed(2)}ms가 500ms 회귀 상한을 초과했습니다`);
    child.kill("SIGTERM");
    const exit = await new Promise((resolvePromise) =>
      child.once("exit", (code, signal) => resolvePromise({ code, signal })),
    );
    if (exit.code !== 0 || exit.signal !== null)
      throw new Error(`부하 후 daemon 종료가 실패했습니다: ${JSON.stringify(exit)}`);
    if (errors.length > 0) throw new Error(`daemon stderr가 비어 있지 않습니다: ${errors.join("").slice(0, 512)}`);
    process.stdout.write(
      `${JSON.stringify({ requests: total, concurrency, failures, p95Ms: Number(p95Ms.toFixed(2)), shutdown: "clean" })}\n`,
    );
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) await main();
