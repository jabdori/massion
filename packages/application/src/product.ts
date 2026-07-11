import { createHash, createHmac, randomUUID } from "node:crypto";

import type { PolicyStore } from "@massion/governance";
import type { IdentityService, OrganizationService, TenantContext } from "@massion/identity";
import type { OrganizationGraphService } from "@massion/organization";
import type { MassionDatabase } from "@massion/storage";

import { registerApplicationDomainCommands, type ApplicationDomainDependencies } from "./adapters/domain.js";
import { registerApplicationAccessCommands } from "./access-commands.js";
import { SurrealApplicationReadModel } from "./adapters/read-model.js";
import { ApplicationAccessTokenService } from "./auth.js";
import type { ApplicationArtifactGateway } from "./artifacts.js";
import { LocalApplicationBootstrap } from "./bootstrap.js";
import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";
import { CoreWorkCoordinator, type CoreWorkStage, type CoreWorkStageExecutor } from "./core-work-coordinator.js";
import { ApplicationEventProjector } from "./event-projector.js";
import { ApplicationEventStore } from "./event-store.js";
import {
  ApplicationHttpServer,
  type ApplicationHttpDependencies,
  type ApplicationHttpServerOptions,
} from "./http-server.js";
import {
  registerApplicationIntegrationOperations,
  type ApplicationIntegrationOperations,
} from "./integration-operations.js";
import { ApplicationMetricStore } from "./metrics.js";
import {
  ApplicationQueryRegistry,
  registerApplicationQueries,
  type ApplicationQueryDependencies,
} from "./query-registry.js";
import { registerApplicationRunCommands } from "./run-commands.js";
import { registerApplicationRegistryOperations, type ApplicationRegistryOperations } from "./registry-operations.js";
import { ApplicationRunStore } from "./run-store.js";
import { CollaborationGraphSnapshotProjector } from "./snapshot.js";
import { WebSessionService } from "./web-session.js";

export interface ApplicationProductDependencies {
  readonly database: MassionDatabase;
  readonly identities: IdentityService;
  readonly organizations: OrganizationService;
  readonly graph: OrganizationGraphService;
  readonly policies: PolicyStore;
  readonly tokenKey: { readonly keyId: string; readonly key: Buffer };
  readonly executors: Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>>;
  readonly domain: ApplicationDomainDependencies;
  readonly queries?: Omit<
    ApplicationQueryDependencies,
    "readModel" | "snapshot" | "memberships" | "audit" | "webSessions"
  >;
  readonly artifacts?: Pick<ApplicationArtifactGateway, "inspect" | "install" | "update">;
  readonly integrations?: {
    readonly http?: NonNullable<ApplicationHttpDependencies["integrations"]>;
    readonly operations?: ApplicationIntegrationOperations;
  };
  readonly registry?: ApplicationRegistryOperations;
  readonly registryPublisher?: NonNullable<ApplicationHttpDependencies["registryPublisher"]>;
  readonly health?: NonNullable<ApplicationHttpDependencies["health"]>;
  readonly server?: ApplicationHttpServerOptions;
}

export class ApplicationProduct implements AsyncDisposable {
  private readonly background = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];

  private constructor(
    public readonly server: ApplicationHttpServer,
    public readonly commands: ApplicationCommandRegistry,
    public readonly queries: ApplicationQueryRegistry,
    public readonly runs: ApplicationRunStore,
    public readonly coordinator: CoreWorkCoordinator,
    public readonly tokens: ApplicationAccessTokenService,
    public readonly events: ApplicationEventStore,
    public readonly projector: ApplicationEventProjector,
    public readonly metrics: ApplicationMetricStore,
    public readonly webSessions: WebSessionService,
  ) {}

  public static async create(dependencies: ApplicationProductDependencies): Promise<ApplicationProduct> {
    const runs = await ApplicationRunStore.create(dependencies.database, dependencies.organizations);
    const coordinator = new CoreWorkCoordinator(runs, dependencies.executors);
    const commandStore = await ApplicationCommandStore.create(dependencies.database, dependencies.organizations);
    const commands = new ApplicationCommandRegistry(commandStore);
    registerApplicationDomainCommands(commands, dependencies.domain);

    const readModel = new SurrealApplicationReadModel(dependencies.database, dependencies.organizations);
    const snapshot = new CollaborationGraphSnapshotProjector(readModel);
    const queries = new ApplicationQueryRegistry();

    const tokens = await ApplicationAccessTokenService.create(dependencies.database, dependencies.organizations, {
      keyId: dependencies.tokenKey.keyId,
      key: dependencies.tokenKey.key,
    });
    const metrics = await ApplicationMetricStore.create(dependencies.database, dependencies.organizations);
    const webSessions = await WebSessionService.create(dependencies.database, dependencies.organizations, tokens, {
      keyId: `web-${createHash("sha256").update(dependencies.tokenKey.keyId).digest("hex").slice(0, 16)}`,
      key: createHmac("sha256", dependencies.tokenKey.key).update("massion-web-session-v1").digest(),
      telemetry: {
        async record(context, input) {
          await metrics.recordOnce(context, input.idempotencyKey, {
            name: "application_request_total",
            value: 1,
            dimensions: { operationClass: input.action, result: "succeeded" },
          });
        },
      },
    });
    const events = await ApplicationEventStore.create(dependencies.database, dependencies.organizations);
    const projector = await ApplicationEventProjector.create(dependencies.database, dependencies.organizations);
    registerApplicationAccessCommands(commands, { organizations: dependencies.organizations, webSessions });
    registerApplicationQueries(queries, {
      ...dependencies.queries,
      readModel,
      snapshot,
      memberships: dependencies.organizations,
      audit: events,
      webSessions,
    });
    if (dependencies.integrations?.operations)
      registerApplicationIntegrationOperations(commands, queries, dependencies.integrations.operations);
    registerApplicationRegistryOperations(
      commands,
      queries,
      dependencies.registry ?? {
        search() {
          return Promise.resolve({ items: [] });
        },
        info() {
          return Promise.reject(new Error("Registry가 구성되지 않았습니다"));
        },
        inventory() {
          return Promise.resolve([]);
        },
        install() {
          return Promise.reject(new Error("Registry가 구성되지 않았습니다"));
        },
        recall() {
          return Promise.reject(new Error("Registry가 구성되지 않았습니다"));
        },
      },
    );
    const bootstrap = new LocalApplicationBootstrap(
      dependencies.identities,
      dependencies.organizations,
      dependencies.graph,
      dependencies.policies,
      tokens,
    );

    const productReference: { current?: ApplicationProduct } = {};
    registerApplicationRunCommands(commands, {
      store: runs,
      coordinator,
      schedule(context, runId) {
        if (!productReference.current) throw new Error("Application product 조립이 완료되지 않았습니다");
        productReference.current.schedule(context, runId);
      },
    });
    const server = new ApplicationHttpServer(
      {
        auth: tokens,
        queries: {
          async query(context, scopes, operation, payload) {
            const started = performance.now();
            const operationClass = operation.split(".", 1)[0] ?? "unknown";
            const key = randomUUID();
            try {
              const output = await queries.query(context, scopes, operation, payload);
              await metrics.recordOnce(context, `${key}:total`, {
                name: "application_request_total",
                value: 1,
                dimensions: { operationClass, result: "succeeded" },
              });
              await metrics.recordOnce(context, `${key}:duration`, {
                name: "application_request_duration_ms",
                value: performance.now() - started,
                dimensions: { operationClass, result: "succeeded" },
              });
              return output;
            } catch (error) {
              await metrics.recordOnce(context, `${key}:total`, {
                name: "application_request_total",
                value: 1,
                dimensions: { operationClass, result: "failed" },
              });
              throw error;
            }
          },
        },
        commands: {
          async dispatch(context, scopes, input) {
            const output = await commands.dispatch(context, scopes, input);
            await metrics.recordOnce(context, `${output.commandId}:command`, {
              name: "application_command_total",
              value: 1,
              dimensions: {
                operationClass: output.operation.split(".", 1)[0] ?? "unknown",
                result: output.outcome,
              },
            });
            await projector.projectPending(context, 1_000);
            return output;
          },
        },
        events: {
          async read(context, input) {
            await projector.projectPending(context, 1_000);
            return await events.read(context, input);
          },
        },
        tokens,
        ...(dependencies.artifacts === undefined ? {} : { artifacts: dependencies.artifacts }),
        ...(dependencies.integrations?.http === undefined ? {} : { integrations: dependencies.integrations.http }),
        ...(dependencies.registryPublisher === undefined ? {} : { registryPublisher: dependencies.registryPublisher }),
        ...(dependencies.health === undefined ? {} : { health: dependencies.health }),
        bootstrap,
        webSessions,
      },
      dependencies.server,
    );
    const product = new ApplicationProduct(
      server,
      commands,
      queries,
      runs,
      coordinator,
      tokens,
      events,
      projector,
      metrics,
      webSessions,
    );
    productReference.current = product;
    return product;
  }

  public async start(): Promise<{ readonly host: string; readonly port: number; readonly url: string }> {
    return await this.server.start();
  }

  public async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
    if (this.failures.length > 0) {
      const failures = this.failures.splice(0);
      throw new AggregateError(failures, "Application background run이 실패했습니다");
    }
  }

  public async close(): Promise<void> {
    await this.server.close();
    await this.drain();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private schedule(context: TenantContext, runId: string): void {
    const task = Promise.resolve()
      .then(async () => {
        const run = await this.coordinator.recover(context, runId);
        await this.metrics.recordOnce(context, `${runId}:run:${String(run.leaseGeneration)}`, {
          name: "application_run_total",
          value: 1,
          dimensions: { stage: run.stage, result: run.status },
        });
        await this.projector.projectPending(context, 1_000);
      })
      .catch((error: unknown) => {
        this.failures.push(error);
      })
      .finally(() => {
        this.background.delete(task);
      });
    this.background.add(task);
  }
}
