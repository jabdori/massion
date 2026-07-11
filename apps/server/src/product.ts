import { APPLICATION_RUN_STAGES, ApplicationProduct, type CoreWorkStageExecutor } from "@massion/application";
import { PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import type { ServerConfig } from "./config.js";
import { MassionDaemon } from "./daemon.js";

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
    daemon = new MassionDaemon({ application, database, shutdownTimeoutMs: config.shutdownTimeoutMs });
    return daemon;
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}
