import { APPLICATION_RUN_STAGES, ApplicationProduct, type CoreWorkStageExecutor } from "@massion/application";
import { PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import type { ServerConfig } from "./config.js";
import { MassionDaemon } from "./daemon.js";
import { JsonOperationalLogger, MetricRegistry, MetricsHttpServer } from "./telemetry.js";

export async function provisionRemoteDatabase(
  config: ServerConfig,
  fetcher: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = async (milliseconds) =>
    await new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  if (config.mode !== "team" || !config.database.authentication) return;
  const endpoint = new URL(config.database.url);
  endpoint.protocol = endpoint.protocol === "wss:" || endpoint.protocol === "https:" ? "https:" : "http:";
  endpoint.pathname = "/sql";
  endpoint.search = "";
  endpoint.hash = "";
  const authorization = Buffer.from(
    `${config.database.authentication.username}:${config.database.authentication.password}`,
  ).toString("base64");
  const statement = `DEFINE NAMESPACE IF NOT EXISTS ${config.database.namespace}; USE NS ${config.database.namespace}; DEFINE DATABASE IF NOT EXISTS ${config.database.database};`;
  let status = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { authorization: `Basic ${authorization}`, accept: "application/json", "content-type": "text/plain" },
        body: statement,
        signal: AbortSignal.timeout(3_000),
      });
      status = response.status;
      if (response.ok) return;
      if (response.status !== 503) break;
    } catch {
      status = 0;
    }
    await wait(500);
  }
  throw new Error(`SurrealDB namespace/database 준비에 실패했습니다 (${String(status || "unreachable")})`);
}

export function createLimitedExecutors(): Readonly<
  Record<(typeof APPLICATION_RUN_STAGES)[number], CoreWorkStageExecutor>
> {
  return Object.fromEntries(
    APPLICATION_RUN_STAGES.map((stage) => [
      stage,
      {
        execute: async () => ({ outcome: "blocked" as const, reason: "model-unavailable" }),
      },
    ]),
  ) as unknown as Readonly<Record<(typeof APPLICATION_RUN_STAGES)[number], CoreWorkStageExecutor>>;
}

export async function createMassionDaemon(config: ServerConfig): Promise<MassionDaemon> {
  await provisionRemoteDatabase(config);
  const database = await createDatabase(config.database);
  try {
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const works = await WorkService.create(database, organizations, graph);
    let daemon: MassionDaemon | undefined;
    const application = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: config.tokenKey,
      executors: createLimitedExecutors(),
      domain: { works, organization: graph },
      queries: {
        status: async () => ({
          status: "ready",
          mode: config.mode,
          database: await database.version(),
          modelRuntime: "limited",
        }),
      },
      health: { readiness: async () => (daemon ? await daemon.readiness() : { database: true, migrations: true }) },
      server: config.server,
    });
    const metrics = new MetricRegistry({ massion_daemon_transition_total: ["state"] });
    const metricsServer = new MetricsHttpServer(metrics, config.metrics);
    const operations = new JsonOperationalLogger((line) => process.stderr.write(`${line}\n`));
    daemon = new MassionDaemon({
      application,
      database,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      operationalServices: [metricsServer],
      onState: (state) => metrics.increment("massion_daemon_transition_total", { state }),
      onReadinessFailure: (component) => operations.write("server.readiness.failed", { component }),
    });
    return daemon;
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}
