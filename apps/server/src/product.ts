import { APPLICATION_RUN_STAGES, ApplicationProduct, type CoreWorkStageExecutor } from "@massion/application";
import { PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { FileArtifactStore, RegistryCatalog, RegistryHttpHandler, SurrealRegistryStore } from "@massion/registry";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import type { DatabaseProvisionConfig, ServerConfig } from "./config.js";
import { MassionDaemon } from "./daemon.js";
import { RegistryReadHttpServer } from "./registry-server.js";
import { JsonOperationalLogger, MetricRegistry, MetricsHttpServer } from "./telemetry.js";

export async function provisionRemoteDatabase(
  config: DatabaseProvisionConfig,
  fetcher: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = async (milliseconds) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
): Promise<void> {
  const endpoint = new URL(config.url);
  endpoint.protocol = endpoint.protocol === "wss:" || endpoint.protocol === "https:" ? "https:" : "http:";
  endpoint.pathname = "/sql";
  endpoint.search = "";
  endpoint.hash = "";
  const authorization = Buffer.from(
    `${config.owner.username}:${config.owner.password}`,
  ).toString("base64");
  const statement = `DEFINE NAMESPACE IF NOT EXISTS ${config.namespace}; USE NS ${config.namespace}; DEFINE DATABASE IF NOT EXISTS ${config.database}; USE DB ${config.database}; DEFINE USER OVERWRITE ${config.runtime.username} ON DATABASE PASSWORD ${JSON.stringify(config.runtime.password)} ROLES EDITOR;`;
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
      if (response.ok) {
        const results: unknown = await response.json().catch(() => undefined);
        if (
          Array.isArray(results) &&
          results.length === 5 &&
          results.every(
            (result: unknown) =>
              result !== null && typeof result === "object" && "status" in result && result.status === "OK",
          )
        )
          return;
        break;
      }
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
        execute: () => Promise.resolve({ outcome: "blocked" as const, reason: "model-unavailable" }),
      },
    ]),
  ) as unknown as Readonly<Record<(typeof APPLICATION_RUN_STAGES)[number], CoreWorkStageExecutor>>;
}

export async function createMassionDaemon(config: ServerConfig): Promise<MassionDaemon> {
  const database = await createDatabase(config.database);
  try {
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const works = await WorkService.create(database, organizations, graph);
    const registryStore = await SurrealRegistryStore.create(database, organizations);
    const registryCatalog = new RegistryCatalog(registryStore.catalogStore(), { tokenSecret: config.registry.tokenKey });
    const registryHandler = new RegistryHttpHandler({
      catalog: registryCatalog,
      artifacts: new FileArtifactStore(config.registry.artifactRoot),
      publicBaseUrl: config.registry.publicBaseUrl,
    });
    const registryServer = new RegistryReadHttpServer(registryHandler, config.registry);
    const daemonReference: { current?: MassionDaemon } = {};
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
      health: {
        readiness: async () =>
          daemonReference.current ? await daemonReference.current.readiness() : { database: true, migrations: true },
      },
      server: config.server,
    });
    const metrics = new MetricRegistry({ massion_daemon_transition_total: ["state"] });
    const metricsServer = new MetricsHttpServer(metrics, config.metrics);
    const operations = new JsonOperationalLogger((line) => process.stderr.write(`${line}\n`));
    const daemon = new MassionDaemon({
      application,
      database,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      operationalServices: [registryServer, metricsServer],
      onState: (state) => {
        metrics.increment("massion_daemon_transition_total", { state });
      },
      onReadinessFailure: (component) => {
        operations.write("server.readiness.failed", { component });
      },
    });
    daemonReference.current = daemon;
    return daemon;
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}
