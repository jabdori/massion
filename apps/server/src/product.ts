import {
  ApplicationProduct,
  CoreAssuranceStage,
  CoreDeliveryStage,
  CoreEvidenceStage,
  CoreRecordsStage,
  CoreSoftwareTaskAdapter,
  DatabaseCoreAssuranceCheckOrchestrator,
  DeterministicRecordsDocumentPlanner,
  createCoreWorkPipelineExecutors,
  type CoreWorkStage,
  type CoreWorkStageExecutor,
} from "@massion/application";
import {
  AssuranceBindingStore,
  AssuranceBootstrap,
  AssuranceCheckStore,
  GovernanceBindingActivationAuthorizer,
} from "@massion/assurance";
import { ContextStore, StrategyGenerator, StrategyService } from "@massion/context-strategy";
import { EvidenceBriefStore, IndexStore, RepositoryStore } from "@massion/evidence";
import { ExtensionStore } from "@massion/extension-host";
import {
  ApprovalStore,
  EmergencyControl,
  GovernanceGate,
  GovernanceService,
  PermitStore,
  PolicyStore,
} from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { FileArtifactStore, RegistryCatalog, RegistryHttpHandler, SurrealRegistryStore } from "@massion/registry";
import { RecordsService } from "@massion/records";
import { CredentialVault, ModelRouter, ProviderService } from "@massion/router";
import {
  EmbeddedVoltAgentRuntime,
  MassionModelFactory,
  OpenAICompatibleModelBuilder,
  OrganizationAgentTopology,
  RoutedModelRegistry,
  RuntimeExecutionStore,
  VoltAgentRunner,
  type AgentExecutionInput,
  type StructuredOutputSpec,
} from "@massion/runtime";
import {
  ConfinedCommandRunner,
  EngineeringDeliveryCoordinator,
  EngineeringDeliveryRecovery,
  EngineeringDeliveryStore,
  EngineeringMetricStore,
  EngineeringPathLeaseStore,
  GitWorkspaceManager,
  SoftwareDeliveryFinalizer,
  SoftwarePatchProposalService,
  TddDeliveryEngine,
  WorkServiceDeliveryPort,
  type DeliveryPrerequisiteReader,
  type EngineeringCoordinationPort,
} from "@massion/software-engineering";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import type { DatabaseProvisionConfig, ServerConfig } from "./config.js";
import { MassionDaemon } from "./daemon.js";
import { RegistryReadHttpServer } from "./registry-server.js";
import { JsonOperationalLogger, MetricRegistry, MetricsHttpServer } from "./telemetry.js";

const CORE_MODEL_ROUTES = [
  "orchestration-balanced",
  "planning-quality",
  "delivery-quality",
  "assurance-independent",
  "software-engineering-quality",
] as const;

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
  const authorization = Buffer.from(`${config.owner.username}:${config.owner.password}`).toString("base64");
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

export function createLimitedExecutors(): Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>> {
  const blocked: CoreWorkStageExecutor = {
    execute: () => Promise.resolve({ outcome: "blocked", reason: "model-unavailable" }),
  };
  return {
    intake: blocked,
    "context-strategy": blocked,
    evidence: blocked,
    delivery: blocked,
    assurance: blocked,
    records: blocked,
  };
}

export async function createMassionDaemon(config: ServerConfig): Promise<MassionDaemon> {
  const database = await createDatabase(config.database);
  try {
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const governanceGate = new GovernanceGate(governance, approvals, permits, emergency);
    const works = await WorkService.create(database, organizations, graph);
    await ExtensionStore.create(database, organizations);
    const providers = await ProviderService.create(database, organizations, new CredentialVault(config.credentialKey));
    const router = await ModelRouter.create(database, organizations, providers);
    const runtimeExecutions = await RuntimeExecutionStore.create(database, organizations);
    const modelRegistry = new RoutedModelRegistry();
    const topologyRuntime = new EmbeddedVoltAgentRuntime(modelRegistry.resolve);
    const routedRunner = new VoltAgentRunner(
      topologyRuntime,
      runtimeExecutions,
      new MassionModelFactory(router, providers, new OpenAICompatibleModelBuilder()),
      modelRegistry,
    );
    const topologies = new Map<string, OrganizationAgentTopology>();
    const synchronize = async (context: Parameters<typeof graph.listNodes>[0]) => {
      let topology = topologies.get(context.organizationId);
      if (!topology) {
        topology = new OrganizationAgentTopology(
          context.organizationId,
          { listNodes: async () => await graph.listNodes(context) },
          topologyRuntime,
          () => Promise.resolve(routedRunner.activeCount),
        );
        topologies.set(context.organizationId, topology);
      }
      await topology.sync();
    };
    const runner = {
      async execute(context: Parameters<typeof routedRunner.execute>[0], input: AgentExecutionInput) {
        await synchronize(context);
        return await routedRunner.execute(context, input);
      },
      async executeStructured(
        context: Parameters<typeof routedRunner.executeStructured>[0],
        input: AgentExecutionInput,
        output: StructuredOutputSpec,
      ) {
        await synchronize(context);
        return await routedRunner.executeStructured(context, input, output);
      },
      stream: routedRunner.stream.bind(routedRunner),
      cancel: routedRunner.cancel.bind(routedRunner),
      suspend: routedRunner.suspend.bind(routedRunner),
      resume: routedRunner.resume.bind(routedRunner),
      recover: routedRunner.recover.bind(routedRunner),
    };
    const contexts = await ContextStore.create(database, organizations, works);
    const strategyGenerator = await StrategyGenerator.create(database, organizations, runner, contexts, works);
    const strategy = StrategyService.create(contexts, strategyGenerator, works);
    const repositories = await RepositoryStore.create(database, organizations);
    const indexes = await IndexStore.create(database, organizations);
    const briefs = await EvidenceBriefStore.create(database, repositories, indexes);
    const assurance = await AssuranceBootstrap.create(database, organizations);
    const assuranceBindings = await AssuranceBindingStore.create(
      database,
      organizations,
      new GovernanceBindingActivationAuthorizer(governanceGate),
      { allowedAuthorHandles: ["assurance", "representative"] },
    );
    const assuranceChecks = new AssuranceCheckStore(database, organizations);
    const assuranceOrchestrator = new DatabaseCoreAssuranceCheckOrchestrator({
      runs: assurance,
      bindings: assuranceBindings,
      checks: assuranceChecks,
      works,
    });
    const records = await RecordsService.create(database, organizations);
    const deliveryPrerequisites: DeliveryPrerequisiteReader = {
      async getWork(context, workId) {
        const work = await works.getWork(context, workId);
        return {
          organizationId: work.organization_id,
          workId: work.work_id,
          status: work.status,
        };
      },
      async getTask(context, workId, taskId) {
        const task = (await works.listTasks(context, workId)).find((candidate) => candidate.task_id === taskId);
        if (!task) throw new Error("Software Delivery Task를 찾을 수 없습니다");
        return {
          organizationId: task.organization_id,
          workId: task.work_id,
          taskId: task.task_id,
          status: task.status,
        };
      },
      async getAssignment(context, workId, assignmentId) {
        const assignment = (await works.listAssignments(context, workId)).find(
          (candidate) => candidate.assignment_id === assignmentId,
        );
        if (!assignment) throw new Error("Software Delivery Assignment를 찾을 수 없습니다");
        return {
          organizationId: assignment.organization_id,
          workId: assignment.work_id,
          taskId: assignment.task_id,
          assignmentId: assignment.assignment_id,
          agentHandle: assignment.agent_handle,
          status: assignment.status,
        };
      },
      async getRepository(context, repositoryId) {
        const repository = await repositories.getRepository(context, repositoryId);
        return {
          organizationId: repository.organizationId,
          repositoryId: repository.repositoryId,
          status: repository.status,
          rootRealPathHash: repository.rootRealPathHash,
        };
      },
      async getRepositoryRevision(context, repositoryRevisionId) {
        const revision = await repositories.getRevision(context, repositoryRevisionId);
        return {
          organizationId: revision.organizationId,
          repositoryId: revision.repositoryId,
          repositoryRevisionId: revision.repositoryRevisionId,
          providerRevision: revision.providerRevision,
          dirty: revision.dirty,
          rootRealPathHash: revision.rootRealPathHash,
        };
      },
    };
    const engineeringDeliveries = await EngineeringDeliveryStore.create(database, organizations, deliveryPrerequisites);
    const engineeringLeases = await EngineeringPathLeaseStore.create(database, organizations);
    const engineeringCoordination: EngineeringCoordinationPort = {
      async getWork(context, workId) {
        const work = await works.getWork(context, workId);
        return {
          organizationId: work.organization_id,
          workId: work.work_id,
          status: work.status,
          revision: work.revision,
        };
      },
      async getTask(context, workId, taskId) {
        const task = (await works.listTasks(context, workId)).find((candidate) => candidate.task_id === taskId);
        if (!task) throw new Error("Software Delivery Task를 찾을 수 없습니다");
        return {
          organizationId: task.organization_id,
          workId: task.work_id,
          taskId: task.task_id,
          status: task.status,
          revision: task.revision,
          requiredCapabilities: task.required_capabilities ?? [],
          recommendedAgentHandles: task.recommended_agent_handles ?? [],
        };
      },
      async getAssignment(context, workId, assignmentId) {
        return await deliveryPrerequisites.getAssignment(context, workId, assignmentId);
      },
      async getCurrentIndex(context, repositoryId) {
        const index = await repositories.getCurrentIndex(context, repositoryId);
        return index
          ? {
              repositoryId: index.repositoryId,
              repositoryRevisionId: index.repositoryRevisionId,
              status: index.status,
              current: index.current,
            }
          : undefined;
      },
      listOrganizationNodes: async (context) => await graph.listNodes(context),
      async transitionTask(context, input) {
        const result = await works.transitionTask(context, {
          commandId: input.commandId,
          workId: input.workId,
          expectedRevision: input.expectedWorkRevision,
          taskId: input.taskId,
          expectedTaskRevision: input.expectedTaskRevision,
          target: input.target,
        });
        return { taskId: result.task.task_id, status: "running", revision: result.task.revision };
      },
    };
    const engineeringCoordinator = new EngineeringDeliveryCoordinator(
      engineeringDeliveries,
      engineeringLeases,
      engineeringCoordination,
    );
    const engineeringWorkspaces = await GitWorkspaceManager.create({ workspaceRoot: config.software.workspaceRoot });
    const engineeringEngine = new TddDeliveryEngine(engineeringDeliveries, engineeringWorkspaces, {
      create: async (workspaceRoot) =>
        await ConfinedCommandRunner.create({
          workspaceRoot,
          executables: config.software.executables,
          environmentAllowlist: config.software.environmentAllowlist,
          maxTimeoutMs: 3_600_000,
          maxOutputBytes: 10_000_000,
          maxExcerptBytes: 64_000,
        }),
    });
    const engineeringMetrics = await EngineeringMetricStore.create(database, organizations);
    const engineeringFinalizer = new SoftwareDeliveryFinalizer(
      engineeringDeliveries,
      new WorkServiceDeliveryPort(works),
      governanceGate,
    );
    const engineeringRecovery = new EngineeringDeliveryRecovery(
      engineeringDeliveries,
      engineeringWorkspaces,
      engineeringLeases,
      engineeringMetrics,
      undefined,
      engineeringFinalizer,
    );
    const software = new CoreSoftwareTaskAdapter({
      works,
      deliveries: engineeringDeliveries,
      coordinator: engineeringCoordinator,
      proposals: new SoftwarePatchProposalService(runner),
      engine: engineeringEngine,
      finalizer: engineeringFinalizer,
      recovery: engineeringRecovery,
    });
    const evidenceStage = new CoreEvidenceStage({ works, briefs });
    const deliveryStage = new CoreDeliveryStage({ works, runner, runtimeExecutions, software });
    const assuranceStage = new CoreAssuranceStage({
      works,
      bindings: assuranceBindings,
      runner,
      assurance,
      checks: assuranceOrchestrator,
    });
    const recordsStage = new CoreRecordsStage({
      works,
      records,
      documents: new DeterministicRecordsDocumentPlanner(),
    });
    const executors = createCoreWorkPipelineExecutors({
      graph,
      works,
      representative: runner,
      runtimeExecutions,
      strategy,
      evidence: evidenceStage,
      delivery: deliveryStage,
      assurance: assuranceStage,
      records: recordsStage,
    });
    const registryStore = await SurrealRegistryStore.create(database, organizations);
    const registryCatalog = new RegistryCatalog(registryStore.catalogStore(), {
      tokenSecret: config.registry.tokenKey,
    });
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
      executors,
      domain: { works, organization: graph, runtime: runner, approvals, assuranceBindings, providers, router },
      queries: {
        runtime: runtimeExecutions,
        assuranceBindings,
        providers,
        router,
        status: async (context) => {
          const configured = await router.listRoutes(context);
          const configuredNames = new Set(configured.map((route) => route.name));
          const missingRoutes = CORE_MODEL_ROUTES.filter((name) => !configuredNames.has(name));
          const diagnostics = await Promise.all(
            CORE_MODEL_ROUTES.filter((name) => configuredNames.has(name)).map(
              async (routeName) =>
                await router.diagnose(context, [{ routeName, estimatedTokens: 1, estimatedCostMicros: 0 }]),
            ),
          );
          const blockedRoutes = diagnostics.flatMap((diagnostic) =>
            diagnostic.routes.filter((route) => route.status !== "available").map((route) => route.routeName),
          );
          return {
            status: "ready",
            mode: config.mode,
            database: await database.version(),
            modelRuntime: missingRoutes.length === 0 && blockedRoutes.length === 0 ? "ready" : "limited",
            modelRuntimeDetails: { missingRoutes, blockedRoutes },
          };
        },
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
