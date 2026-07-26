import { hkdfSync } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  ApplicationProduct,
  CoreAssuranceStage,
  ExecutionStreamRegistry,
  CoreDeliveryStage,
  CoreEvidenceStage,
  CoreRecordsStage,
  CoreSoftwareTaskAdapter,
  CodeChangeAssuranceRecipeResolver,
  ApplicationArtifactGateway,
  DatabaseCoreAssuranceCheckOrchestrator,
  DeterministicRecordsDocumentPlanner,
  SubscriptionConnectionService,
  createCoreWorkPipelineExecutors,
  type CoreWorkStage,
  type CoreWorkStageExecutor,
  type WorkKnowledgeViewV1,
} from "@massion/application";
import {
  AssuranceBindingStore,
  AssuranceBootstrap,
  AssuranceCheckStore,
  GovernanceBindingActivationAuthorizer,
} from "@massion/assurance";
import { ContextStore, StrategyGenerator, StrategyService } from "@massion/context-strategy";
import {
  CodeGraphService,
  CodeSearchService,
  EvidenceBriefStore,
  EvidenceContextBinder,
  EvidenceFreshnessService,
  EvidenceIndexer,
  EvidenceParser,
  EvidencePromptMaterializer,
  IndexStore,
  RepositoryRevisionCollector,
  RepositoryScanner,
  RepositoryStore,
  WorkspaceKnowledgeService,
} from "@massion/evidence";
import {
  ExtensionGateway,
  ExtensionGovernanceAdapter,
  ExtensionLifecycleService,
  ExtensionPackageService,
  ExtensionStore,
  ExtensionWorkerSupervisor,
  FileArtifactStore as ExtensionFileArtifactStore,
} from "@massion/extension-host";
import {
  GrowthAdoptionService,
  GrowthBootstrap,
  GrowthComplianceAuditor,
  GrowthConfigurationStore,
  GrowthEffectStore,
  GrowthEvaluationStore,
  GrowthAgentConfigurationReader,
  GrowthGateway,
  GrowthGovernanceAdapter,
  GrowthRecoveryService,
  GrowthRevertService,
  GrowthRuntimeAgentIdentityReader,
  GrowthTriggerStore,
  GrowthTargetRegistry,
  GrowthWorkPromptAdapter,
  MemoryGrowthTarget,
  OrganizationGrowthTarget,
  PolicyGrowthTarget,
  PromptGrowthTarget,
  PromptMemoryStore,
  ReflectionService,
} from "@massion/growth";
import {
  ApprovalStore,
  EmergencyControl,
  GovernanceGate,
  GovernanceService,
  PermitStore,
  PolicyGrowthProjection,
  PolicyStore,
} from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { isOptimizationRoleKey, ModelOptimizationStore, OptimizationBatchService } from "@massion/model-optimization";
import { OrganizationGraphService, OrganizationGrowthProjection } from "@massion/organization";
import {
  FileArtifactStore,
  RegistryApplicationAdapter,
  RegistryCatalog,
  RegistryHttpHandler,
  RegistryInstaller,
  SurrealRegistryStore,
} from "@massion/registry";
import { RecordsService } from "@massion/records";
import { CredentialVault, ModelRouter, ProviderService } from "@massion/router";
import {
  AgentInstructionRegistry,
  DirectExecutionLifecycle,
  EmbeddedVoltAgentRuntime,
  MassionModelFactory,
  OpenAICompatibleModelBuilder,
  OrganizationAgentTopology,
  RoutedModelRegistry,
  RuntimeRecovery,
  RuntimeExecutionStore,
  VoltAgentRunner,
  type AgentExecutionInput,
  type StructuredOutputSpec,
} from "@massion/runtime";
import {
  ConfinedCommandRunner,
  DatabaseSoftwareAssuranceSourceReader,
  EngineeringDeliveryCoordinator,
  EngineeringDeliveryRecovery,
  EngineeringDeliveryStore,
  EngineeringMetricStore,
  EngineeringPathLeaseStore,
  GitWorkspaceManager,
  SoftwareDeliveryFinalizer,
  SoftwareAssuranceAdapter,
  SoftwareSecurityInspectionExecutor,
  SoftwarePatchProposalService,
  TddDeliveryEngine,
  WorkServiceDeliveryPort,
  type DeliveryPrerequisiteReader,
  type EngineeringCoordinationPort,
} from "@massion/software-engineering";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import {
  ConnectorEnrollmentService,
  ConnectorRegistry,
  ServerConnectorProvisioningService,
  SubscriptionAccountService,
  SubscriptionConnectorBroker,
  SubscriptionPolicyStore,
  SubscriptionQuotaService,
} from "@massion/subscriptions";
import { WorkService } from "@massion/work";
import { WorkspaceService } from "@massion/workspace";

import type { DatabaseProvisionConfig, ServerConfig } from "./config.js";
import { MassionDaemon } from "./daemon.js";
import { ApplicationRunStartupRecoveryService } from "./application-run-startup-recovery.js";
import { ConnectorChannelAuthenticator, ConnectorChannelHub } from "./connector-channel.js";
import { ConnectorMaintenanceService } from "./connector-maintenance.js";
import { ConnectorChannelPersistence } from "./connector-persistence.js";
import { ConnectorWebSocketService } from "./connector-websocket.js";
import { BundledCodexSubscriptionObserver } from "./codex-subscription-observer.js";
import { MiniMaxSubscriptionVerifier } from "./minimax-subscription-verifier.js";
import { ZaiCodingPlanSubscriptionVerifier } from "./zai-coding-plan-subscription-verifier.js";
import { RegistryReadHttpServer } from "./registry-server.js";
import { RuntimeStartupRecoveryService } from "./runtime-startup-recovery.js";
import { ServerConnectorLifecycleService } from "./server-connector-lifecycle.js";
import { ServerConnectorStartupRecoveryService } from "./server-connector-startup-recovery.js";
import { BUILTIN_CORE_MODEL_ROUTES, BuiltinModelRouteAssembler } from "./server-model-route-assembler.js";
import { BundledServerConnectorRuntimeAttestor } from "./server-runtime-attestor.js";
import { ServerSubscriptionConnectionService } from "./server-subscription-connection.js";
import { MassionSubscriptionExecutionContext } from "./subscription-execution-context.js";
import { executeOptimizationCase } from "./model-optimization-executor.js";
import { GovernanceSubscriptionPermissionBridge, SubscriptionAgentPolicyResolver } from "./subscription-governance.js";
import { SubscriptionQuotaSynchronizationService } from "./subscription-quota-sync.js";
import { MassionSubscriptionRuntimeResolver } from "./subscription-runtime-resolver.js";
import { GovernanceSubscriptionSharingAuthorizer } from "./subscription-sharing.js";
import { JsonOperationalLogger, MetricRegistry, MetricsHttpServer } from "./telemetry.js";
import { seedBundledOfficialExtensions } from "./bundled-official-extensions.js";
import { createGrowthReflectionAdapters, GrowthWorker } from "./growth-worker.js";

const CORE_MODEL_ROUTES = BUILTIN_CORE_MODEL_ROUTES.map((route) => route.name);

export function deriveSubscriptionFingerprintKey(credentialKey: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      credentialKey,
      Buffer.from("massion-subscription-fingerprint-salt-v1", "utf8"),
      Buffer.from("subscription-account-profile-fingerprint-v1", "utf8"),
      32,
    ),
  );
}

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

export interface MassionDaemonAssemblyOptions {
  /** 테스트와 내장 배포에서 이미 연결된 Database의 소유권을 daemon에 넘깁니다. */
  readonly database?: MassionDatabase;
}

export async function createMassionDaemon(
  config: ServerConfig,
  options: MassionDaemonAssemblyOptions = {},
): Promise<MassionDaemon> {
  const database = options.database ?? (await createDatabase(config.database));
  try {
    const operations = new JsonOperationalLogger((line) => process.stderr.write(`${line}\n`));
    await mkdir(config.connectors.root, { recursive: true, mode: 0o700 });
    await chmod(config.connectors.root, 0o700);
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const growthRuntimeIdentities = new GrowthRuntimeAgentIdentityReader(database, organizations);
    const governanceGate = new GovernanceGate(governance, approvals, permits, emergency, growthRuntimeIdentities);
    const subscriptionPermissionBridge = new GovernanceSubscriptionPermissionBridge(
      governanceGate,
      config.mode,
      approvals,
    );
    // growth의 PromptMemoryStore는 work 실행 시 agent 프롬프트에 장기 기억을 주입하는 PromptVersionResolver 어댑터로 연결된다.
    const growthPrompts = await PromptMemoryStore.create(database, organizations);
    const workPromptVersions = await GrowthWorkPromptAdapter.create(database, organizations, growthPrompts);
    const agentConfigurations = new GrowthAgentConfigurationReader(database, organizations, growthPrompts);
    const instructions = new AgentInstructionRegistry(agentConfigurations);
    // governance 자리는 본 작업 범위 밖이므로 그대로 두고 promptVersions만 주입한다.
    const works = await WorkService.create(
      database,
      organizations,
      graph,
      undefined,
      workPromptVersions,
      (context, executor) => governance.autonomy.get(context, executor),
    );
    const workspaces = await WorkspaceService.create(database, organizations);
    const extensionStore = await ExtensionStore.create(database, organizations);
    const connectorEnrollment = await ConnectorEnrollmentService.create(database, organizations);
    const subscriptionConnectors = await ConnectorRegistry.create(database, organizations, connectorEnrollment, {
      heartbeatTtlMs: config.connectors.heartbeatMs,
    });
    const subscriptionPolicies = await SubscriptionPolicyStore.create(database, organizations);
    const subscriptionQuota = await SubscriptionQuotaService.create(database, organizations);
    const subscriptionAccounts = await SubscriptionAccountService.create(
      database,
      organizations,
      deriveSubscriptionFingerprintKey(config.credentialKey),
      new GovernanceSubscriptionSharingAuthorizer(governanceGate, config.mode),
    );
    const connectorChannels = new ConnectorChannelHub();
    const subscriptionConnectorCommands = {
      enroll: subscriptionConnectors.enroll.bind(subscriptionConnectors),
      revoke: async (context: Parameters<typeof subscriptionConnectors.revoke>[0], connectorId: string) => {
        const revoked = await subscriptionConnectors.revoke(context, connectorId);
        await connectorChannels.disconnect({ organizationId: context.organizationId, connectorId });
        return revoked;
      },
    };
    const connectorBroker = await SubscriptionConnectorBroker.create(database, organizations, subscriptionAccounts, {
      transport: connectorChannels,
    });
    const providers = await ProviderService.create(database, organizations, new CredentialVault(config.credentialKey), {
      accounts: subscriptionAccounts,
    });
    const router = await ModelRouter.create(database, organizations, providers, {
      accounts: subscriptionAccounts,
      quota: subscriptionQuota,
      policies: subscriptionPolicies,
    });
    const modelFactoryReference: { current?: MassionModelFactory } = {};
    const optimizationEvaluationReference: { current?: ModelOptimizationStore } = {};
    const subscriptionExecutionContext = new MassionSubscriptionExecutionContext(
      join(config.connectors.root, "workspaces"),
      works,
      {
        hasOptimizationRun: async (context, runId) =>
          (await optimizationEvaluationReference.current?.hasEvaluationRun(context, runId)) ?? false,
      },
    );
    const optimizationEvaluations = await ModelOptimizationStore.create(database, organizations, {
      modelCatalog: async (context) => {
        const [models, routes] = await Promise.all([router.listModels(context), router.listRoutes(context)]);
        return models.map((model) => {
          const route = routes.find((candidate) => candidate.equivalence_group === model.equivalence_group);
          return {
            modelProfileId: model.model_profile_id,
            modelId: model.model_id,
            routeId: route?.route_id ?? model.endpoint_id,
            providerId: model.provider_id,
            verified: model.verified && model.enabled,
            supportsStructuredOutput: model.supports_structured_output,
            supportsTools: model.supports_tools,
            supportsStreaming: model.supports_streaming,
            dataPolicy: route?.data_policy ?? "external-allowed",
          };
        });
      },
      executor: {
        execute: async (input) => {
          const modelFactory = modelFactoryReference.current;
          const profile = input.profile;
          if (!modelFactory || !profile) throw new Error("모델 평가용 Runtime profile이 구성되지 않았습니다");
          if (!input.case.prompt) throw new Error("실제 평가 실행에는 prompt가 필요합니다");
          const routes = await router.listRoutes(input.context);
          const route = routes.find((candidate) => candidate.route_id === profile.routeId);
          if (!route) throw new Error("모델 평가용 Route를 찾을 수 없습니다");
          const workId = `optimization:${input.run.runId}`;
          const workspace = await subscriptionExecutionContext.resolve(input.context, {
            executionId: input.run.runId,
            workId,
            agentHandle: input.roleKey,
          });
          const lease = await modelFactory.acquire(input.context, {
            commandId: `${input.run.runId}:${input.case.caseId}:reserve`,
            executionId: input.run.runId,
            workId,
            agentHandle: input.roleKey,
            workspaceRoot: workspace.workspaceRoot,
            routeName: route.name,
            preferredModelProfileIds: [input.modelProfileId],
            estimatedTokens: 4_096,
            estimatedCostMicros: 0,
          });
          return await executeOptimizationCase({
            lease,
            executionId: input.run.runId,
            caseId: input.case.caseId,
            prompt: input.case.prompt ?? "",
            expectedOutcome: input.case.expectedOutcome,
          });
        },
      },
    });
    optimizationEvaluationReference.current = optimizationEvaluations;
    const optimizationBatches = await OptimizationBatchService.create(database, organizations);
    const codexSubscriptionObserver = new BundledCodexSubscriptionObserver({
      profileRoot: join(config.connectors.root, "profiles"),
    });
    const subscriptionConnections = new SubscriptionConnectionService(database, subscriptionAccounts, providers);
    const serverRuntimeAttestor = new BundledServerConnectorRuntimeAttestor(database, {
      profileRoot: join(config.connectors.root, "profiles"),
    });
    const serverConnectors = await ServerConnectorProvisioningService.create(database, organizations, {
      runtimeAttestor: serverRuntimeAttestor,
    });
    const subscriptionQuotaSynchronization = new SubscriptionQuotaSynchronizationService(
      database,
      organizations,
      providers,
      subscriptionQuota,
      {
        intervalMs: 120_000,
        maximumConcurrency: 4,
        fetchCodexQuota: async (input) => await codexSubscriptionObserver.readQuota(input),
        onTransition: (transition) => {
          if (transition.attempted > 0) operations.write("subscription.quota.synchronized", { ...transition });
        },
        onUnavailable: (failure) => {
          operations.write("subscription.quota.unavailable", { ...failure });
        },
        onCodexAuthenticationRequired: async (input) => {
          await serverConnectors.markReauthenticationRequired(input.context, {
            commandId: input.commandId,
            connectorId: input.connectorId,
          });
        },
      },
    );
    const builtinModelRoutes = new BuiltinModelRouteAssembler(router);
    const serverSubscriptionConnections = new ServerSubscriptionConnectionService(
      serverConnectors,
      subscriptionConnections,
      subscriptionAccounts,
      builtinModelRoutes,
      codexSubscriptionObserver,
      {
        profileRoot: join(config.connectors.root, "profiles"),
        connectors: subscriptionConnectors,
        logout: async (providerId, input) => {
          if (providerId !== "openai-codex") {
            throw new Error("이 서버 구독 Provider의 원격 logout 계약이 구성되지 않았습니다");
          }
          const loggedOut = await codexSubscriptionObserver.logout({
            organizationId: input.organizationId,
            accountId: input.accountId,
          });
          if (!loggedOut) {
            operations.write("subscription.logout.skipped", {
              providerId: "openai-codex",
              reason: "managed-profile-credential-unavailable",
            });
          }
        },
      },
      new MiniMaxSubscriptionVerifier(),
      subscriptionQuotaSynchronization,
      new ZaiCodingPlanSubscriptionVerifier(),
    );
    const runtimeExecutions = await RuntimeExecutionStore.create(
      database,
      organizations,
      agentConfigurations,
      (context, executor) => governance.autonomy.get(context, executor),
    );
    const directExecutionLifecycle = new DirectExecutionLifecycle(
      new RuntimeRecovery(runtimeExecutions, { getWorkflowState: () => Promise.resolve(null) }),
    );
    const modelRegistry = new RoutedModelRegistry();
    const topologyRuntime = new EmbeddedVoltAgentRuntime(modelRegistry.resolve);
    const subscriptionRuntimeResolver = new MassionSubscriptionRuntimeResolver({
      accounts: subscriptionAccounts,
      connectors: subscriptionConnectors,
      broker: connectorBroker,
      workspaceCapabilities: subscriptionExecutionContext,
      policies: new SubscriptionAgentPolicyResolver(policies, config.mode, subscriptionPolicies, governance.autonomy),
      profileRoot: join(config.connectors.root, "profiles"),
      executableAllowlist: config.connectors.executables,
      permissions: {
        codex: subscriptionPermissionBridge,
        claude: subscriptionPermissionBridge,
      },
    });
    const modelFactory = new MassionModelFactory(
      router,
      providers,
      new OpenAICompatibleModelBuilder(),
      {
        broker: connectorBroker,
        resolver: subscriptionRuntimeResolver,
        routeAttempts: { read: async (context, attemptId) => await router.readAttempt(context, attemptId) },
      },
      {
        resolve: async (context, input) => {
          if (!input.agentHandle || !isOptimizationRoleKey(input.agentHandle)) return undefined;
          const active = await optimizationBatches.getActiveBatch(context, input.agentHandle);
          if (!active) return undefined;
          return [
            ...(active.primaryModelProfileId ? [active.primaryModelProfileId] : []),
            ...active.fallbackModelProfileIds,
          ];
        },
      },
    );
    modelFactoryReference.current = modelFactory;
    const executionStream = new ExecutionStreamRegistry();
    const routedRunner = new VoltAgentRunner(
      topologyRuntime,
      runtimeExecutions,
      modelFactory,
      modelRegistry,
      directExecutionLifecycle,
      subscriptionExecutionContext,
      { subscriptionApprovals: subscriptionPermissionBridge, deltaObserver: executionStream },
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
          instructions,
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
      async *stream(context: Parameters<typeof routedRunner.execute>[0], input: AgentExecutionInput) {
        await synchronize(context);
        yield* routedRunner.stream(context, input);
      },
      cancel: routedRunner.cancel.bind(routedRunner),
      cancelOrganization: routedRunner.cancelOrganization.bind(routedRunner),
      suspend: routedRunner.suspend.bind(routedRunner),
      resume: routedRunner.resume.bind(routedRunner),
      recover: routedRunner.recover.bind(routedRunner),
    };
    const runtimeRecovery = new RuntimeStartupRecoveryService(
      runtimeExecutions,
      {
        resolveTenantContext: async (userId, organizationId) =>
          await organizations.resolveTenantContext(userId, organizationId),
      },
      runner,
      {
        onFailure: (failure) => {
          operations.write("runtime.startup_recovery.failed", {
            reason: failure.reason,
            ...(failure.executionId === undefined ? {} : { executionId: failure.executionId }),
            ...(failure.organizationId === undefined ? {} : { organizationId: failure.organizationId }),
          });
        },
      },
    );
    const contexts = await ContextStore.create(database, organizations, works);
    const repositories = await RepositoryStore.create(database, organizations);
    const indexes = await IndexStore.create(database, organizations);
    const briefs = await EvidenceBriefStore.create(database, repositories, indexes);
    const scanner = new RepositoryScanner();
    const parser = new EvidenceParser();
    const workspaceKnowledge = new WorkspaceKnowledgeService(
      repositories,
      indexes,
      new RepositoryRevisionCollector(scanner),
      new EvidenceIndexer(repositories, indexes, scanner, parser),
      await CodeSearchService.create(database, repositories, indexes),
      new CodeGraphService(repositories, indexes),
      briefs,
      {
        scanOptions: { include: ["**/*"], exclude: [], maxFileBytes: 1_048_576 },
        parserBundleVersion: parser.bundleVersion,
      },
    );
    const evidencePromptMaterializer = new EvidencePromptMaterializer(repositories, indexes, briefs);
    // 동기 stub: await가 필요 없으므로 즉시 이행되는 Promise로 계약(Promise<boolean>)을 유지합니다.
    const evidenceFreshness = new EvidenceFreshnessService(repositories, { enqueue: () => Promise.resolve(false) });
    const evidenceContextBinder = new EvidenceContextBinder(briefs, evidenceFreshness);
    const strategyGenerator = await StrategyGenerator.create(
      database,
      organizations,
      runner,
      contexts,
      works,
      graph,
      evidencePromptMaterializer,
    );
    const strategy = StrategyService.create(contexts, strategyGenerator, works);
    const assurance = await AssuranceBootstrap.create(database, organizations);
    const assuranceBindings = await AssuranceBindingStore.create(
      database,
      organizations,
      new GovernanceBindingActivationAuthorizer(governanceGate),
      { allowedAuthorHandles: ["assurance", "representative"] },
    );
    const records = await RecordsService.create(database, organizations);
    const growthAuthorizer = new GrowthGovernanceAdapter(governanceGate);
    const growthConfigurations = await GrowthConfigurationStore.create(database, organizations, growthAuthorizer);
    const growthEvaluations = await GrowthEvaluationStore.create(database, organizations);
    const growthRecovery = await GrowthRecoveryService.create(database, organizations);
    const growthTargets = new GrowthTargetRegistry({
      prompt: new PromptGrowthTarget(growthPrompts),
      memory: new MemoryGrowthTarget(growthPrompts),
      policy: new PolicyGrowthTarget(new PolicyGrowthProjection(policies)),
      organization: new OrganizationGrowthTarget(new OrganizationGrowthProjection(graph)),
    });
    const reflectionAdapters = createGrowthReflectionAdapters(database, organizations, runner);
    const growthReflections = await ReflectionService.create(
      database,
      organizations,
      { generate: reflectionAdapters.generate },
      { verify: reflectionAdapters.verifySource },
      { verify: reflectionAdapters.verifyRuntime },
    );
    const growth = new GrowthGateway({
      bootstrap: new GrowthBootstrap(
        graph,
        growthPrompts,
        growthEvaluations,
        new GrowthComplianceAuditor(database, organizations),
        growthRecovery,
      ),
      configurations: growthConfigurations,
      prompts: growthPrompts,
      reflections: growthReflections,
      evaluations: growthEvaluations,
      adoptions: await GrowthAdoptionService.create(
        database,
        organizations,
        growthAuthorizer,
        growthTargets,
        (context, executor) => governance.autonomy.get(context, executor),
      ),
      effects: await GrowthEffectStore.create(database, organizations),
      reverts: await GrowthRevertService.create(database, organizations, growthAuthorizer, growthTargets),
      recovery: growthRecovery,
    });
    const growthTriggers = await GrowthTriggerStore.create(database, organizations, growthConfigurations);
    const growthWorker = new GrowthWorker({
      database,
      organizations,
      triggers: growthTriggers,
      gateway: growth,
      runner,
    });
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
    const softwareAssuranceReader = new DatabaseSoftwareAssuranceSourceReader(database, organizations);
    const softwareAssuranceAdapter = await SoftwareAssuranceAdapter.create(softwareAssuranceReader, {
      workspaceRoot: join(config.software.workspaceRoot, "assurance-command"),
      executables: config.software.executables,
      environmentProfiles: { default: {} },
      maxTimeoutMs: 3_600_000,
      maxOutputBytes: 10_000_000,
      maxExcerptBytes: 64_000,
    });
    const softwareSecurityInspection = await SoftwareSecurityInspectionExecutor.create(softwareAssuranceReader, {
      workspaceRoot: join(config.software.workspaceRoot, "assurance-security"),
    });
    const assuranceChecks = new AssuranceCheckStore(database, organizations, {
      trustedExecutors: [softwareAssuranceAdapter],
      trustedInspectionExecutors: [softwareSecurityInspection],
    });
    const assuranceOrchestrator = new DatabaseCoreAssuranceCheckOrchestrator({
      runs: assurance,
      bindings: assuranceBindings,
      checks: assuranceChecks,
      works,
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
    const evidenceStage = new CoreEvidenceStage({
      works,
      contexts,
      briefs,
      materializer: evidencePromptMaterializer,
    });
    const workKnowledge = {
      async get(context: Parameters<typeof works.getWork>[0], workId: string): Promise<WorkKnowledgeViewV1> {
        const work = await works.getWork(context, workId);
        if (work.workspace_id === undefined) return { workId, status: "not-applicable", references: [] };
        try {
          const automatic = await briefs.findAutomaticByWork(context, workId);
          let sources: Awaited<ReturnType<typeof contexts.get>>["selectedSources"] = [];
          if (work.context_version_id) {
            const contextVersion = await contexts.get(context, work.context_version_id);
            if (contextVersion.workId !== workId) throw new Error("ContextVersion과 Work가 일치하지 않습니다");
            sources = contextVersion.selectedSources.filter((source) => source.kind === "evidence");
          }
          if (sources.length === 0 && automatic?.status === "no_match") {
            const verified = await evidencePromptMaterializer.verifyNoMatch(context, {
              workId,
              evidenceBriefId: automatic.evidenceBriefId,
            });
            const freshness = await evidenceFreshness.assess(context, verified, "warn");
            if (freshness.status !== "fresh" && freshness.status !== "stale_warning")
              throw new Error("no-match EvidenceBrief freshness를 계산할 수 없습니다");
            return {
              workId,
              status: "no-match",
              repositoryId: verified.repositoryId,
              repositoryRevisionId: verified.repositoryRevisionId,
              indexVersionId: verified.indexVersionId,
              evidenceBriefId: verified.evidenceBriefId,
              freshnessStatus: freshness.status,
              query: verified.query,
              references: [],
            };
          }
          if (sources.length !== 1) throw new Error("active evidence source는 하나여야 합니다");
          const reference = sources[0]?.evidenceRef;
          if (!reference) throw new Error("Evidence reference가 없습니다");
          if (automatic && automatic.evidenceBriefId !== reference.evidenceBriefId)
            throw new Error("automatic EvidenceBrief와 active ContextVersion이 다릅니다");
          const materials = await evidenceStage.materializeActive(context, workId);
          if (materials.length !== 1 || materials[0]?.evidenceBriefId !== reference.evidenceBriefId)
            throw new Error("active evidence materialization 결과가 일치하지 않습니다");
          const brief = await briefs.getBrief(context, reference.evidenceBriefId);
          if (brief.references.length === 0 || brief.references.some((item) => item.kind !== "code"))
            throw new Error("ready EvidenceBrief에 코드 근거가 없습니다");
          const snapshot = await indexes.getSnapshot(context, brief.indexVersionId);
          const symbolByKey = new Map(snapshot.symbols.map((symbol) => [symbol.symbolKey, symbol]));
          const freshness = await evidenceFreshness.assess(context, brief, "warn");
          if (freshness.status !== "fresh" && freshness.status !== "stale_warning")
            throw new Error("ready EvidenceBrief freshness를 계산할 수 없습니다");
          return {
            workId,
            status: "ready",
            repositoryId: brief.repositoryId,
            repositoryRevisionId: brief.repositoryRevisionId,
            indexVersionId: brief.indexVersionId,
            evidenceBriefId: brief.evidenceBriefId,
            freshnessStatus: freshness.status,
            query: brief.query,
            references: brief.references.map((item) => {
              if (item.kind !== "code") throw new Error("코드 근거가 아닌 reference입니다");
              const qualifiedName =
                item.sourceKind === "symbol"
                  ? snapshot.symbols.find((symbol) => symbol.symbolId === item.referenceId)?.qualifiedName
                  : symbolByKey.get(
                      snapshot.chunks.find((chunk) => chunk.chunkId === item.referenceId)?.symbolKey ?? "",
                    )?.qualifiedName;
              return {
                referenceId: item.referenceId,
                kind: item.sourceKind,
                relativePath: item.relativePath,
                startLine: item.startLine,
                endLine: item.endLine,
                contentHash: item.contentHash,
                ...(qualifiedName ? { qualifiedName } : {}),
              };
            }),
          };
        } catch {
          return { workId, status: "blocked", references: [], failureReason: "knowledge-integrity-check-failed" };
        }
      },
    };
    const deliveryStage = new CoreDeliveryStage({
      works,
      runner,
      runtimeExecutions,
      software,
      workspaces,
      evidence: evidenceStage,
    });
    const assuranceStage = new CoreAssuranceStage({
      works,
      bindings: assuranceBindings,
      runner,
      runtimeExecutions,
      assurance,
      checks: assuranceOrchestrator,
      softwareAssuranceRecipes: new CodeChangeAssuranceRecipeResolver(),
    });
    const recordsStage = new CoreRecordsStage({
      works,
      records,
      documents: new DeterministicRecordsDocumentPlanner(),
    });
    const executors = createCoreWorkPipelineExecutors({
      graph,
      works,
      workspaces,
      workspaceKnowledge,
      evidencePromptMaterializer,
      evidenceContextBinder,
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
    // ponytail: registry read handler 와 installer 가 동일 artifact 저장소를 공유합니다.
    const artifactStore = new FileArtifactStore(config.registry.artifactRoot);
    const registryHandler = new RegistryHttpHandler({
      catalog: registryCatalog,
      artifacts: artifactStore,
      publicBaseUrl: config.registry.publicBaseUrl,
    });
    const registryServer = new RegistryReadHttpServer(registryHandler, config.registry);
    const extensionRuntime = { agentOS: "1.0.0", node: process.versions.node, surrealDB: "3.2.0" };
    if (config.registry.bundledExtensionsRoot) {
      await seedBundledOfficialExtensions({
        root: config.registry.bundledExtensionsRoot,
        identities,
        organizations,
        versions: registryStore,
        artifacts: artifactStore,
        runtime: extensionRuntime,
      });
    }
    // ponytail: Extension lifecycle artifact 저장소는 registry artifactRoot 를 재사용(하위 경로가 겹치지 않음).
    const extensionLifecycle = new ExtensionLifecycleService({
      runtime: extensionRuntime,
      store: extensionStore,
      artifacts: new ExtensionFileArtifactStore(config.registry.artifactRoot),
      authorizer: new ExtensionGovernanceAdapter(governanceGate),
      workers: new ExtensionWorkerSupervisor(),
    });
    const extensionGateway = new ExtensionGateway(
      extensionLifecycle,
      new ExtensionPackageService({ runtime: extensionRuntime }),
    );
    const registryInstaller = new RegistryInstaller({
      catalog: registryCatalog,
      artifacts: artifactStore,
      lifecycle: extensionLifecycle,
      runtime: extensionRuntime,
    });
    const registryAdapter = new RegistryApplicationAdapter({
      catalog: registryCatalog,
      versions: registryStore,
      catalogVersions: registryStore.catalogStore(),
      installer: registryInstaller,
      inventory: { list: (context) => extensionStore.listInstallations(context) },
      runtime: extensionRuntime,
    });
    const daemonReference: { current?: MassionDaemon } = {};
    const application = await ApplicationProduct.create({
      executionStream,
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: config.tokenKey,
      executors,
      autonomyTransition: {
        autonomy: governance.autonomy,
        approvals,
        runtime: runner,
        runtimeExecutions,
        emergency,
      },
      domain: {
        works,
        workspaces,
        autonomy: governance.autonomy,
        emergency,
        organization: graph,
        runtime: runner,
        approvals,
        assuranceBindings,
        extension: extensionGateway,
        growth,
        providers,
        router,
        optimization: { evaluations: optimizationEvaluations, batches: optimizationBatches },
        subscriptionAccounts,
        subscriptionServerConnections: serverSubscriptionConnections,
        subscriptionConnectors: subscriptionConnectorCommands,
        subscriptionPolicy: subscriptionPolicies,
      },
      queries: {
        runtime: runtimeExecutions,
        workspaces,
        workKnowledge,
        autonomy: governance.autonomy,
        emergency,
        provenance: {
          listByWork: async (provenanceContext, workId) =>
            (await engineeringDeliveries.listByWork(provenanceContext, workId)).map((delivery) => ({
              deliveryId: delivery.deliveryId,
              taskId: delivery.taskId,
              agentHandle: delivery.agentHandle,
              status: delivery.status,
              ...(delivery.branchRef === undefined ? {} : { branchRef: delivery.branchRef }),
              ...(delivery.commitSha === undefined ? {} : { commitSha: delivery.commitSha }),
              createdAt: delivery.createdAt,
            })),
        },
        workTimeline: {
          events: async (timelineContext, workId) => await works.listEvents(timelineContext, workId),
          rooms: async (timelineContext, workId) => await works.listRooms(timelineContext, workId),
          messages: async (timelineContext, workId, roomId) =>
            await works.listMessages(timelineContext, workId, roomId),
        },
        assuranceBindings,
        extension: extensionGateway,
        growth,
        providers,
        router,
        optimization: { evaluations: optimizationEvaluations, batches: optimizationBatches },
        subscriptionAccounts,
        subscriptionConnectors,
        subscriptionQuota,
        subscriptionPolicy: subscriptionPolicies,
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
      artifacts: new ApplicationArtifactGateway(extensionGateway),
      registry: registryAdapter,
      connectorEnrollments: connectorEnrollment,
      health: {
        readiness: async () =>
          daemonReference.current
            ? await daemonReference.current.readiness()
            : { database: true, migrations: true, connectors: true },
      },
      onInitialized: (context) => growthWorker.start(context),
      server: config.server,
    });
    const applicationRunRecovery = new ApplicationRunStartupRecoveryService(
      application.runs,
      {
        resolveTenantContext: async (userId, organizationId) =>
          await organizations.resolveTenantContext(userId, organizationId),
      },
      application.coordinator,
      {
        onFailure: (failure) => {
          operations.write("application.run.startup_recovery.failed", {
            reason: failure.reason,
            ...(failure.runId === undefined ? {} : { runId: failure.runId }),
            ...(failure.organizationId === undefined ? {} : { organizationId: failure.organizationId }),
          });
        },
      },
    );
    const metrics = new MetricRegistry({ massion_daemon_transition_total: ["state"] });
    const metricsServer = new MetricsHttpServer(metrics, config.metrics);
    const serverConnectorLifecycle = new ServerConnectorLifecycleService(database, {
      onTransition: (transition) => {
        operations.write("subscription.server_connector.lifecycle", { ...transition });
      },
    });
    const serverConnectorStartupRecovery = new ServerConnectorStartupRecoveryService(
      database,
      organizations,
      serverConnectors,
      {
        onTransition: (transition) => {
          operations.write("subscription.server_connector.startup_recovery", { ...transition });
        },
        onUnavailable: (failure) => {
          operations.write("subscription.server_connector.startup_unavailable", { ...failure });
        },
      },
    );
    const connectorMaintenance = new ConnectorMaintenanceService(subscriptionConnectors, {
      intervalMs: Math.max(1_000, Math.floor(config.connectors.heartbeatMs / 2)),
      onError: () => {
        operations.write("connector.expiry.failed");
      },
    });
    const connectorPersistence = new ConnectorChannelPersistence(database, subscriptionConnectors);
    const connectorWebSocket = config.connectors.edgeEnabled
      ? new ConnectorWebSocketService({
          server: application.server.upgradeServer(),
          hub: connectorChannels,
          authenticator: new ConnectorChannelAuthenticator({
            publicKeys: connectorPersistence,
            nonceClaims: connectorPersistence,
          }),
          lifecycle: connectorPersistence,
          trustedProxyAddresses: config.server.trustedProxyAddresses ?? [],
          expirySweepIntervalMs: Math.max(1_000, Math.floor(config.connectors.heartbeatMs / 2)),
        })
      : undefined;
    const daemon = new MassionDaemon({
      application,
      database,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      beforeListenServices: [
        serverConnectorLifecycle,
        serverConnectorStartupRecovery,
        runtimeRecovery,
        applicationRunRecovery,
      ],
      drainServices: [
        {
          close: async () => {
            await extensionLifecycle.close();
          },
        },
        {
          close: async () => {
            await growthWorker.close();
          },
        },
        {
          close: async () => {
            await routedRunner.shutdown("daemon_shutdown");
          },
        },
      ],
      afterListenServices: [
        registryServer,
        metricsServer,
        connectorMaintenance,
        subscriptionQuotaSynchronization,
        {
          start: () => Promise.resolve(),
          close: async () => {
            await connectorChannels.shutdown();
          },
        },
        ...(connectorWebSocket
          ? [
              {
                start: () => Promise.resolve(),
                close: async () => {
                  await connectorWebSocket.shutdown();
                },
              },
            ]
          : []),
      ],
      readinessComponents: {
        connectors: () => Promise.resolve(connectorMaintenance.ready()),
        "server-connectors": () =>
          Promise.resolve(serverConnectorLifecycle.ready() && serverConnectorStartupRecovery.ready()),
        "subscription-quota": () => Promise.resolve(subscriptionQuotaSynchronization.ready()),
        "runtime-recovery": () => Promise.resolve(runtimeRecovery.ready()),
        "application-run-recovery": () => Promise.resolve(applicationRunRecovery.ready()),
      },
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
