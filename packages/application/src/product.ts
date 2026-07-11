import type { PolicyStore } from "@massion/governance";
import type { IdentityService, OrganizationService, TenantContext } from "@massion/identity";
import type { OrganizationGraphService } from "@massion/organization";
import type { MassionDatabase } from "@massion/storage";

import { registerApplicationDomainCommands, type ApplicationDomainDependencies } from "./adapters/domain.js";
import { SurrealApplicationReadModel } from "./adapters/read-model.js";
import { ApplicationAccessTokenService } from "./auth.js";
import type { ApplicationArtifactGateway } from "./artifacts.js";
import { LocalApplicationBootstrap } from "./bootstrap.js";
import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";
import { CoreWorkCoordinator, type CoreWorkStage, type CoreWorkStageExecutor } from "./core-work-coordinator.js";
import { ApplicationEventProjector } from "./event-projector.js";
import { ApplicationEventStore } from "./event-store.js";
import { ApplicationHttpServer, type ApplicationHttpServerOptions } from "./http-server.js";
import {
  ApplicationQueryRegistry,
  registerApplicationQueries,
  type ApplicationQueryDependencies,
} from "./query-registry.js";
import { registerApplicationRunCommands } from "./run-commands.js";
import { ApplicationRunStore } from "./run-store.js";
import { CollaborationGraphSnapshotProjector } from "./snapshot.js";

export interface ApplicationProductDependencies {
  readonly database: MassionDatabase;
  readonly identities: IdentityService;
  readonly organizations: OrganizationService;
  readonly graph: OrganizationGraphService;
  readonly policies: PolicyStore;
  readonly tokenKey: { readonly keyId: string; readonly key: Buffer };
  readonly executors: Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>>;
  readonly domain: ApplicationDomainDependencies;
  readonly queries?: Omit<ApplicationQueryDependencies, "readModel" | "snapshot">;
  readonly artifacts?: Pick<ApplicationArtifactGateway, "inspect" | "install" | "update">;
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
    registerApplicationQueries(queries, { ...dependencies.queries, readModel, snapshot });

    const tokens = await ApplicationAccessTokenService.create(dependencies.database, dependencies.organizations, {
      keyId: dependencies.tokenKey.keyId,
      key: dependencies.tokenKey.key,
    });
    const events = await ApplicationEventStore.create(dependencies.database, dependencies.organizations);
    const projector = await ApplicationEventProjector.create(dependencies.database, dependencies.organizations);
    const bootstrap = new LocalApplicationBootstrap(
      dependencies.identities,
      dependencies.organizations,
      dependencies.graph,
      dependencies.policies,
      tokens,
    );

    let product: ApplicationProduct;
    registerApplicationRunCommands(commands, {
      store: runs,
      coordinator,
      schedule(context, runId) {
        product.schedule(context, runId);
      },
    });
    const server = new ApplicationHttpServer(
      {
        auth: tokens,
        queries,
        commands: {
          async dispatch(context, scopes, input) {
            const output = await commands.dispatch(context, scopes, input);
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
        bootstrap,
      },
      dependencies.server,
    );
    product = new ApplicationProduct(server, commands, queries, runs, coordinator, tokens, events, projector);
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
        await this.coordinator.recover(context, runId);
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
