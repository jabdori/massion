import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { classifyFailure, type FailureSignal } from "./failure.js";
import { ProviderService, type ProviderCredential, type ProviderEndpoint, type RouterAuditEvent } from "./provider.js";
import { MODEL_ROUTE_MIGRATION, ROUTER_HEALTH_MIGRATION, ROUTER_REGISTRY_MIGRATION } from "./schema.js";

export type RouteKind = "chat" | "embedding";
export type CredentialPolicy =
  "priority" | "fill-first" | "round-robin" | "weighted" | "least-used" | "quota-headroom" | "reset-aware" | "sticky";

export interface ModelProfile {
  readonly model_profile_id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly endpoint_id: string;
  readonly model_id: string;
  readonly route_kind: RouteKind;
  readonly context_window: number;
  readonly supports_tools: boolean;
  readonly supports_structured_output: boolean;
  readonly supports_vision: boolean;
  readonly supports_streaming: boolean;
  readonly equivalence_group: string;
  readonly eval_score: number;
  readonly verified: boolean;
  readonly enabled: boolean;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface ModelRoute {
  readonly route_id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly route_kind: RouteKind;
  readonly credential_policy: CredentialPolicy;
  readonly data_policy: "external-allowed" | "local-private";
  readonly equivalence_group: string;
  readonly min_eval_score: number;
  readonly require_tools: boolean;
  readonly require_structured_output: boolean;
  readonly require_vision: boolean;
  readonly require_streaming: boolean;
  readonly max_context_tokens: number;
  readonly request_budget_micros: number;
  readonly total_budget_micros: number;
  readonly spent_micros: number;
  readonly selection_sequence: number;
  readonly enabled: boolean;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface RouteCandidate {
  readonly candidate_id: string;
  readonly organization_id: string;
  readonly route_id: string;
  readonly model_profile_id: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly created_at: unknown;
}

export interface RouteAttempt {
  readonly attempt_id: string;
  readonly organization_id: string;
  readonly route_id: string;
  readonly candidate_id: string;
  readonly model_profile_id: string;
  readonly credential_id: string;
  readonly credential_secret_version: number;
  readonly command_id: string;
  readonly status: string;
  readonly failure_class?: string;
  readonly status_code?: number;
  readonly emitted_tokens: number;
  readonly actual_input_tokens: number;
  readonly actual_output_tokens: number;
  readonly actual_cost_micros: number;
  readonly fallback_allowed: boolean;
  readonly retry_at?: unknown;
  readonly selection_sequence: number;
  readonly estimated_tokens: number;
  readonly reserved_cost_micros: number;
  readonly sticky_key_hash?: string;
  readonly fallback_from_attempt_id?: string;
  readonly explanation_json: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface CredentialSelectionView {
  readonly credential_id: string;
  readonly label: string;
  readonly priority: number;
  readonly weight: number;
  readonly request_count: number;
  readonly cost_micros: number;
  readonly quota_limit?: number;
  readonly quota_remaining?: number;
  readonly quota_reset_at?: unknown;
  readonly last_selected_sequence: number;
}

export interface RegisterModelInput {
  readonly commandId: string;
  readonly providerId: string;
  readonly endpointId: string;
  readonly modelId: string;
  readonly routeKind: RouteKind;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsVision: boolean;
  readonly supportsStreaming: boolean;
  readonly equivalenceGroup: string;
  readonly evalScore: number;
  readonly verified: boolean;
}

export interface CreateRouteInput {
  readonly commandId: string;
  readonly name: string;
  readonly routeKind: RouteKind;
  readonly credentialPolicy: CredentialPolicy;
  readonly dataPolicy: "external-allowed" | "local-private";
  readonly equivalenceGroup: string;
  readonly minEvalScore: number;
  readonly requireTools: boolean;
  readonly requireStructuredOutput: boolean;
  readonly requireVision: boolean;
  readonly requireStreaming: boolean;
  readonly maxContextTokens: number;
  readonly requestBudgetMicros: number;
  readonly totalBudgetMicros: number;
}

export interface AddCandidateInput {
  readonly commandId: string;
  readonly routeId: string;
  readonly modelProfileId: string;
  readonly priority: number;
}

export interface RouteRequest {
  readonly routeName: string;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
  readonly stickyKey?: string;
  readonly fallbackFromAttemptId?: string;
}

export interface ReserveRouteInput extends RouteRequest {
  readonly commandId: string;
}

export interface RouteSimulation {
  readonly status: "selected" | "blocked_model_unavailable";
  readonly route: ModelRoute;
  readonly candidate?: RouteCandidate;
  readonly profile?: ModelProfile;
  readonly endpoint?: ProviderEndpoint;
  readonly credential?: ProviderCredential;
  readonly explanation: {
    readonly selected: string[];
    readonly excluded: string[];
  };
  readonly resumeAt?: string;
}

export interface RouteReservation extends RouteSimulation {
  readonly status: "selected";
  readonly attempt: RouteAttempt;
  readonly secret: string;
}

export interface RouteDiagnostic {
  readonly routeName: string;
  readonly routeKind: RouteKind;
  readonly dataPolicy: ModelRoute["data_policy"];
  readonly status: "available" | "blocked_model_unavailable";
  readonly reasons: readonly string[];
  readonly recovery?: string;
  readonly resumeAt?: string;
}

export interface RouterDiagnostic {
  readonly status: "available" | "degraded";
  readonly routes: readonly RouteDiagnostic[];
}

export interface ReportFailureInput {
  readonly commandId: string;
  readonly attemptId: string;
  readonly signal: FailureSignal;
  readonly emittedTokens: number;
  readonly actualInputTokens: number;
  readonly actualOutputTokens: number;
  readonly actualCostMicros: number;
}

export interface ReportSuccessInput {
  readonly commandId: string;
  readonly attemptId: string;
  readonly actualInputTokens: number;
  readonly actualOutputTokens: number;
  readonly actualCostMicros: number;
}

export interface AttemptOutcome {
  readonly attempt: RouteAttempt;
  readonly next?: RouteSimulation;
}

interface RouterCircuit {
  readonly circuit_id: string;
  readonly scope_id: string;
  readonly state: "closed" | "open";
  readonly failure_count: number;
  readonly open_until?: unknown;
  readonly version: number;
}

type CircuitScope = "credential" | "endpoint" | "model";

const POLICIES = new Set<CredentialPolicy>([
  "priority",
  "fill-first",
  "round-robin",
  "weighted",
  "least-used",
  "quota-headroom",
  "reset-aware",
  "sticky",
]);

function serializedMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return new Date(value).getTime();
  const serialized = JSON.stringify(value);
  const parsed = serialized ? (JSON.parse(serialized) as unknown) : undefined;
  return typeof parsed === "string" || typeof parsed === "number"
    ? new Date(parsed).getTime()
    : Number.POSITIVE_INFINITY;
}

export function selectCredential(
  policy: CredentialPolicy,
  credentials: readonly CredentialSelectionView[],
  stickyKey?: string,
): CredentialSelectionView | undefined {
  if (credentials.length === 0) return undefined;
  const ordered = [...credentials].sort((left, right) => left.credential_id.localeCompare(right.credential_id));
  const by = (compare: (left: CredentialSelectionView, right: CredentialSelectionView) => number) =>
    [...ordered].sort(compare)[0];
  if (policy === "fill-first")
    return by((left, right) => left.priority - right.priority || left.credential_id.localeCompare(right.credential_id));
  if (policy === "priority")
    return by(
      (left, right) =>
        left.priority - right.priority ||
        left.last_selected_sequence - right.last_selected_sequence ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (policy === "round-robin")
    return by(
      (left, right) =>
        left.last_selected_sequence - right.last_selected_sequence ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (policy === "weighted")
    return by(
      (left, right) =>
        left.request_count / left.weight - right.request_count / right.weight ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (policy === "least-used")
    return by(
      (left, right) =>
        left.request_count - right.request_count ||
        left.cost_micros - right.cost_micros ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (policy === "quota-headroom") {
    const headroom = (credential: CredentialSelectionView) =>
      credential.quota_limit && credential.quota_remaining !== undefined
        ? credential.quota_remaining / credential.quota_limit
        : 1;
    return by(
      (left, right) => headroom(right) - headroom(left) || left.credential_id.localeCompare(right.credential_id),
    );
  }
  if (policy === "reset-aware")
    return by(
      (left, right) =>
        serializedMillis(left.quota_reset_at) - serializedMillis(right.quota_reset_at) ||
        left.credential_id.localeCompare(right.credential_id),
    );
  if (!stickyKey) throw new Error("sticky policy에는 stickyKey가 필요합니다");
  const totalWeight = ordered.reduce((sum, credential) => sum + credential.weight, 0);
  const digest = createHash("sha256").update(stickyKey).digest();
  let bucket = digest.readUInt32BE(0) % totalWeight;
  for (const credential of ordered) {
    if (bucket < credential.weight) return credential;
    bucket -= credential.weight;
  }
  return ordered.at(-1);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class ModelRouter {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly providers: ProviderService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    providers: ProviderService,
  ): Promise<ModelRouter> {
    await applyMigrations(database, [ROUTER_REGISTRY_MIGRATION, MODEL_ROUTE_MIGRATION, ROUTER_HEALTH_MIGRATION]);
    return new ModelRouter(database, organizations, providers);
  }

  public async registerModel(
    context: TenantContext,
    input: RegisterModelInput,
  ): Promise<{ profile: ModelProfile; audit: RouterAuditEvent }> {
    if (input.contextWindow < 1 || input.evalScore < 0 || input.evalScore > 1)
      throw new Error("Model Profile 수치가 유효하지 않습니다");
    return await this.command(
      context,
      input.commandId,
      "model_profile_registered",
      canonicalJson(input),
      async (tx) => {
        const endpoint = await this.endpoint(tx, context.organizationId, input.endpointId);
        if (endpoint.provider_id !== input.providerId)
          throw new Error("Model Profile의 Provider와 Endpoint가 다릅니다");
        const [profiles] = await tx.query<[ModelProfile[]]>(
          "CREATE model_profile CONTENT { model_profile_id: $profile_id, organization_id: $organization_id, provider_id: $provider_id, endpoint_id: $endpoint_id, model_id: $model_id, route_kind: $route_kind, context_window: $context_window, supports_tools: $supports_tools, supports_structured_output: $supports_structured, supports_vision: $supports_vision, supports_streaming: $supports_streaming, equivalence_group: $equivalence_group, eval_score: $eval_score, verified: $verified, enabled: true, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          {
            profile_id: randomUUID(),
            organization_id: context.organizationId,
            provider_id: input.providerId,
            endpoint_id: input.endpointId,
            model_id: input.modelId,
            route_kind: input.routeKind,
            context_window: input.contextWindow,
            supports_tools: input.supportsTools,
            supports_structured: input.supportsStructuredOutput,
            supports_vision: input.supportsVision,
            supports_streaming: input.supportsStreaming,
            equivalence_group: input.equivalenceGroup,
            eval_score: input.evalScore,
            verified: input.verified,
          },
        );
        if (!profiles[0]) throw new Error("Model Profile 생성 결과가 없습니다");
        return { profile: profiles[0] };
      },
    );
  }

  public async createRoute(
    context: TenantContext,
    input: CreateRouteInput,
  ): Promise<{ route: ModelRoute; audit: RouterAuditEvent }> {
    if (!POLICIES.has(input.credentialPolicy)) throw new Error("지원하지 않는 Credential policy입니다");
    if (input.maxContextTokens < 1 || input.requestBudgetMicros < 0 || input.totalBudgetMicros < 0)
      throw new Error("Route budget 또는 context가 유효하지 않습니다");
    return await this.command(context, input.commandId, "model_route_created", canonicalJson(input), async (tx) => {
      const [routes] = await tx.query<[ModelRoute[]]>(
        "CREATE model_route CONTENT { route_id: $route_id, organization_id: $organization_id, name: $name, route_kind: $route_kind, credential_policy: $credential_policy, data_policy: $data_policy, equivalence_group: $equivalence_group, min_eval_score: $min_eval_score, require_tools: $require_tools, require_structured_output: $require_structured, require_vision: $require_vision, require_streaming: $require_streaming, max_context_tokens: $max_context_tokens, request_budget_micros: $request_budget, total_budget_micros: $total_budget, spent_micros: 0, selection_sequence: 0, enabled: true, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          route_id: randomUUID(),
          organization_id: context.organizationId,
          name: input.name,
          route_kind: input.routeKind,
          credential_policy: input.credentialPolicy,
          data_policy: input.dataPolicy,
          equivalence_group: input.equivalenceGroup,
          min_eval_score: input.minEvalScore,
          require_tools: input.requireTools,
          require_structured: input.requireStructuredOutput,
          require_vision: input.requireVision,
          require_streaming: input.requireStreaming,
          max_context_tokens: input.maxContextTokens,
          request_budget: input.requestBudgetMicros,
          total_budget: input.totalBudgetMicros,
        },
      );
      if (!routes[0]) throw new Error("Model Route 생성 결과가 없습니다");
      return { route: routes[0] };
    });
  }

  public async addCandidate(
    context: TenantContext,
    input: AddCandidateInput,
  ): Promise<{ candidate: RouteCandidate; audit: RouterAuditEvent }> {
    return await this.command(context, input.commandId, "route_candidate_added", canonicalJson(input), async (tx) => {
      const route = await this.routeById(tx, context.organizationId, input.routeId);
      const profile = await this.profile(tx, context.organizationId, input.modelProfileId);
      const endpoint = await this.endpoint(tx, context.organizationId, profile.endpoint_id);
      const failures = this.profileFailures(route, profile, endpoint);
      if (failures.length > 0)
        throw new Error(`Route Candidate가 요구사항을 충족하지 않습니다: ${failures.join(", ")}`);
      const [candidates] = await tx.query<[RouteCandidate[]]>(
        "CREATE model_route_candidate CONTENT { candidate_id: $candidate_id, organization_id: $organization_id, route_id: $route_id, model_profile_id: $profile_id, priority: $priority, enabled: true, created_at: time::now() } RETURN AFTER;",
        {
          candidate_id: randomUUID(),
          organization_id: context.organizationId,
          route_id: route.route_id,
          profile_id: profile.model_profile_id,
          priority: input.priority,
        },
      );
      if (!candidates[0]) throw new Error("Route Candidate 생성 결과가 없습니다");
      return { candidate: candidates[0] };
    });
  }

  public async simulate(context: TenantContext, request: RouteRequest): Promise<RouteSimulation> {
    await this.organizations.verifyTenantContext(context);
    return await this.select(this.database, context, request);
  }

  public async diagnose(context: TenantContext, requests: readonly RouteRequest[]): Promise<RouterDiagnostic> {
    await this.organizations.verifyTenantContext(context);
    const routes: RouteDiagnostic[] = [];
    for (const request of requests) {
      const simulation = await this.select(this.database, context, request);
      const available = simulation.status === "selected";
      const recovery = available
        ? undefined
        : simulation.route.data_policy === "local-private"
          ? "활성 local Endpoint, 검증된 local Model Profile, Candidate와 Credential을 구성해주세요."
          : "요구사항을 만족하는 Model Profile, Candidate와 활성 Credential을 구성해주세요.";
      routes.push({
        routeName: simulation.route.name,
        routeKind: simulation.route.route_kind,
        dataPolicy: simulation.route.data_policy,
        status: available ? "available" : "blocked_model_unavailable",
        reasons: simulation.explanation.excluded,
        ...(recovery ? { recovery } : {}),
        ...(simulation.resumeAt ? { resumeAt: simulation.resumeAt } : {}),
      });
    }
    return { status: routes.every((route) => route.status === "available") ? "available" : "degraded", routes };
  }

  public async reserve(context: TenantContext, input: ReserveRouteInput): Promise<RouteReservation> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const [repeated] = await tx.query<[RouteAttempt[]]>(
        "SELECT * OMIT id FROM route_attempt WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated[0]) return await this.reservationFromAttempt(tx, context, repeated[0], requestJson);
      let excludedCredentialId: string | undefined;
      if (input.fallbackFromAttemptId) {
        const previous = await this.attempt(tx, context.organizationId, input.fallbackFromAttemptId);
        if (!previous.fallback_allowed) throw new Error("이전 Attempt는 fallback이 허용되지 않습니다");
        excludedCredentialId = previous.credential_id;
      }
      const simulation = await this.select(tx, context, input, excludedCredentialId);
      if (
        simulation.status !== "selected" ||
        !simulation.candidate ||
        !simulation.profile ||
        !simulation.endpoint ||
        !simulation.credential
      ) {
        throw new Error(`blocked_model_unavailable: ${simulation.explanation.excluded.join("; ")}`);
      }
      const route = simulation.route;
      if (input.estimatedCostMicros > route.request_budget_micros) throw new Error("요청 예산을 초과했습니다");
      if (route.spent_micros + input.estimatedCostMicros > route.total_budget_micros)
        throw new Error("Route 총 예산을 초과했습니다");
      const sequence = route.selection_sequence + 1;
      await tx.query(
        "UPDATE model_route SET selection_sequence = $sequence, spent_micros += $cost, updated_at = time::now() WHERE organization_id = $organization_id AND route_id = $route_id; UPDATE provider_credential SET status = 'active', cooldown_until = NONE, request_count += 1, cost_micros += $cost, last_selected_sequence = $sequence, quota_remaining = IF quota_remaining != NONE { math::max([0, quota_remaining - 1]) } ELSE { NONE }, updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
        {
          sequence,
          cost: input.estimatedCostMicros,
          organization_id: context.organizationId,
          route_id: route.route_id,
          credential_id: simulation.credential.credential_id,
        },
      );
      const [attempts] = await tx.query<[RouteAttempt[]]>(
        "CREATE route_attempt CONTENT { attempt_id: $attempt_id, organization_id: $organization_id, route_id: $route_id, candidate_id: $candidate_id, model_profile_id: $profile_id, credential_id: $credential_id, credential_secret_version: $secret_version, command_id: $command_id, status: 'reserved', selection_sequence: $sequence, estimated_tokens: $tokens, reserved_cost_micros: $cost, sticky_key_hash: $sticky_hash, fallback_from_attempt_id: $fallback_from, explanation_json: $explanation_json, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          attempt_id: randomUUID(),
          organization_id: context.organizationId,
          route_id: route.route_id,
          candidate_id: simulation.candidate.candidate_id,
          profile_id: simulation.profile.model_profile_id,
          credential_id: simulation.credential.credential_id,
          secret_version: simulation.credential.secret_version,
          command_id: input.commandId,
          sequence,
          tokens: input.estimatedTokens,
          cost: input.estimatedCostMicros,
          sticky_hash: input.stickyKey ? createHash("sha256").update(input.stickyKey).digest("hex") : undefined,
          fallback_from: input.fallbackFromAttemptId,
          explanation_json: canonicalJson({ request: requestJson, explanation: simulation.explanation }),
        },
      );
      const attempt = attempts[0];
      if (!attempt) throw new Error("Route Attempt 생성 결과가 없습니다");
      const secret = await this.providers.resolveExecutionSecretVersion(
        context,
        simulation.credential,
        attempt.credential_secret_version,
        tx,
      );
      return { ...simulation, status: "selected", attempt, secret };
    });
  }

  public async reportFailure(
    context: TenantContext,
    input: ReportFailureInput,
  ): Promise<AttemptOutcome & { audit: RouterAuditEvent }> {
    if (
      input.emittedTokens < 0 ||
      input.actualInputTokens < 0 ||
      input.actualOutputTokens < 0 ||
      input.actualCostMicros < 0
    )
      throw new Error("Attempt 사용량은 음수일 수 없습니다");
    return await this.command(context, input.commandId, "route_attempt_failed", canonicalJson(input), async (tx) => {
      const current = await this.attempt(tx, context.organizationId, input.attemptId);
      if (current.status !== "reserved") throw new Error("reserved 상태의 Attempt만 실패 처리할 수 있습니다");
      const classified = classifyFailure(input.signal);
      const fallbackAllowed = classified.fallbackEligible && input.emittedTokens === 0;
      const status = input.emittedTokens > 0 ? "interrupted" : "failed";
      const costDelta = input.actualCostMicros - current.reserved_cost_micros;
      const retryAt = classified.retryAt
        ? new Date(classified.retryAt)
        : classified.failureClass === "quota"
          ? new Date(Date.now() + 60_000)
          : undefined;
      await tx.query(
        "UPDATE model_route SET spent_micros = math::max([0, spent_micros + $cost_delta]), updated_at = time::now() WHERE organization_id = $organization_id AND route_id = $route_id; UPDATE provider_credential SET status = IF $disable { 'disabled' } ELSE IF $cooldown { 'cooldown' } ELSE { status }, version = IF $disable OR $cooldown { version + 1 } ELSE { version }, cooldown_until = IF $cooldown { $retry_at } ELSE { cooldown_until }, input_tokens += $input_tokens, output_tokens += $output_tokens, cost_micros = math::max([0, cost_micros + $cost_delta]), updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
        {
          organization_id: context.organizationId,
          route_id: current.route_id,
          credential_id: current.credential_id,
          disable: classified.failureClass === "authentication" || classified.failureClass === "billing",
          cooldown: classified.failureClass === "quota",
          retry_at: retryAt,
          input_tokens: input.actualInputTokens,
          output_tokens: input.actualOutputTokens,
          cost_delta: costDelta,
        },
      );
      if (["upstream", "timeout", "network"].includes(classified.failureClass)) {
        const profile = await this.profile(tx, context.organizationId, current.model_profile_id);
        await this.recordCircuitFailure(
          tx,
          context.organizationId,
          "credential",
          current.credential_id,
          classified.failureClass,
        );
        await this.recordCircuitFailure(
          tx,
          context.organizationId,
          "endpoint",
          profile.endpoint_id,
          classified.failureClass,
        );
        await this.recordCircuitFailure(
          tx,
          context.organizationId,
          "model",
          profile.model_profile_id,
          classified.failureClass,
        );
      }
      const [attempts] = await tx.query<[RouteAttempt[]]>(
        "UPDATE route_attempt SET status = $status, failure_class = $failure_class, status_code = $status_code, emitted_tokens = $emitted_tokens, actual_input_tokens = $input_tokens, actual_output_tokens = $output_tokens, actual_cost_micros = $actual_cost, fallback_allowed = $fallback_allowed, retry_at = $retry_at, updated_at = time::now() WHERE organization_id = $organization_id AND attempt_id = $attempt_id RETURN AFTER;",
        {
          organization_id: context.organizationId,
          attempt_id: current.attempt_id,
          status,
          failure_class: classified.failureClass,
          status_code: input.signal.statusCode,
          emitted_tokens: input.emittedTokens,
          input_tokens: input.actualInputTokens,
          output_tokens: input.actualOutputTokens,
          actual_cost: input.actualCostMicros,
          fallback_allowed: fallbackAllowed,
          retry_at: retryAt,
        },
      );
      const attempt = attempts[0];
      if (!attempt) throw new Error("Route Attempt 실패 처리 결과가 없습니다");
      if (!fallbackAllowed) return { attempt };
      const route = await this.routeById(tx, context.organizationId, current.route_id);
      const next = await this.select(
        tx,
        context,
        {
          routeName: route.name,
          estimatedTokens: current.estimated_tokens,
          estimatedCostMicros: current.reserved_cost_micros,
          fallbackFromAttemptId: current.attempt_id,
        },
        current.credential_id,
      );
      return { attempt, next };
    });
  }

  public async reportSuccess(
    context: TenantContext,
    input: ReportSuccessInput,
  ): Promise<{ attempt: RouteAttempt; audit: RouterAuditEvent }> {
    if (input.actualInputTokens < 0 || input.actualOutputTokens < 0 || input.actualCostMicros < 0)
      throw new Error("Attempt 사용량은 음수일 수 없습니다");
    return await this.command(context, input.commandId, "route_attempt_succeeded", canonicalJson(input), async (tx) => {
      const current = await this.attempt(tx, context.organizationId, input.attemptId);
      if (current.status !== "reserved") throw new Error("reserved 상태의 Attempt만 성공 처리할 수 있습니다");
      const costDelta = input.actualCostMicros - current.reserved_cost_micros;
      await tx.query(
        "UPDATE model_route SET spent_micros = math::max([0, spent_micros + $cost_delta]), updated_at = time::now() WHERE organization_id = $organization_id AND route_id = $route_id; UPDATE provider_credential SET input_tokens += $input_tokens, output_tokens += $output_tokens, cost_micros = math::max([0, cost_micros + $cost_delta]), updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
        {
          organization_id: context.organizationId,
          route_id: current.route_id,
          credential_id: current.credential_id,
          input_tokens: input.actualInputTokens,
          output_tokens: input.actualOutputTokens,
          cost_delta: costDelta,
        },
      );
      const profile = await this.profile(tx, context.organizationId, current.model_profile_id);
      await this.recordCircuitSuccess(tx, context.organizationId, "credential", current.credential_id);
      await this.recordCircuitSuccess(tx, context.organizationId, "endpoint", profile.endpoint_id);
      await this.recordCircuitSuccess(tx, context.organizationId, "model", profile.model_profile_id);
      const [attempts] = await tx.query<[RouteAttempt[]]>(
        "UPDATE route_attempt SET status = 'succeeded', emitted_tokens = $output_tokens, actual_input_tokens = $input_tokens, actual_output_tokens = $output_tokens, actual_cost_micros = $actual_cost, fallback_allowed = false, updated_at = time::now() WHERE organization_id = $organization_id AND attempt_id = $attempt_id RETURN AFTER;",
        {
          organization_id: context.organizationId,
          attempt_id: current.attempt_id,
          input_tokens: input.actualInputTokens,
          output_tokens: input.actualOutputTokens,
          actual_cost: input.actualCostMicros,
        },
      );
      if (!attempts[0]) throw new Error("Route Attempt 성공 처리 결과가 없습니다");
      return { attempt: attempts[0] };
    });
  }

  private async select(
    executor: QueryExecutor,
    context: TenantContext,
    request: RouteRequest,
    excludedCredentialId?: string,
  ): Promise<RouteSimulation> {
    const route = await this.routeByName(executor, context.organizationId, request.routeName);
    const budgetFailures: string[] = [];
    if (request.estimatedTokens > route.max_context_tokens) budgetFailures.push("context token 한도 초과");
    if (request.estimatedCostMicros > route.request_budget_micros) budgetFailures.push("요청 예산 초과");
    if (route.spent_micros + request.estimatedCostMicros > route.total_budget_micros) {
      budgetFailures.push("Route 총 예산 초과");
    }
    if (budgetFailures.length > 0) {
      return {
        status: "blocked_model_unavailable",
        route,
        explanation: { selected: [], excluded: budgetFailures },
      };
    }
    const [candidates] = await executor.query<[RouteCandidate[]]>(
      "SELECT * OMIT id FROM model_route_candidate WHERE organization_id = $organization_id AND route_id = $route_id AND enabled = true ORDER BY priority ASC, candidate_id ASC;",
      { organization_id: context.organizationId, route_id: route.route_id },
    );
    const excluded: string[] = [];
    let resumeAt: string | undefined;
    for (const candidate of candidates) {
      const profile = await this.profile(executor, context.organizationId, candidate.model_profile_id);
      const endpoint = await this.endpoint(executor, context.organizationId, profile.endpoint_id);
      const profileFailures = this.profileFailures(route, profile, endpoint);
      if (profileFailures.length > 0) {
        excluded.push(`${profile.model_id}: ${profileFailures.join(", ")}`);
        continue;
      }
      const scopedCircuits = [
        await this.circuit(executor, context.organizationId, "model", profile.model_profile_id),
        await this.circuit(executor, context.organizationId, "endpoint", endpoint.endpoint_id),
      ];
      const openCircuit = scopedCircuits.find(
        (item) => item?.state === "open" && serializedMillis(item.open_until) > Date.now(),
      );
      if (openCircuit) {
        const until = new Date(serializedMillis(openCircuit.open_until)).toISOString();
        excluded.push(`${profile.model_id}/${endpoint.name}: circuit open until ${until}`);
        if (!resumeAt || until < resumeAt) resumeAt = until;
        continue;
      }
      const [credentials] = await executor.query<[ProviderCredential[]]>(
        "SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id AND provider_id = $provider_id AND endpoint_id = $endpoint_id;",
        { organization_id: context.organizationId, provider_id: profile.provider_id, endpoint_id: profile.endpoint_id },
      );
      const now = Date.now();
      const eligible: ProviderCredential[] = [];
      for (const credential of credentials) {
        if (credential.credential_id === excludedCredentialId) {
          excluded.push(`${profile.model_id}/${credential.label}: 이전 실패 Credential 제외`);
          continue;
        }
        const credentialCircuit = await this.circuit(
          executor,
          context.organizationId,
          "credential",
          credential.credential_id,
        );
        if (credentialCircuit?.state === "open" && serializedMillis(credentialCircuit.open_until) > now) {
          const until = new Date(serializedMillis(credentialCircuit.open_until)).toISOString();
          excluded.push(`${profile.model_id}/${credential.label}: circuit open until ${until}`);
          if (!resumeAt || until < resumeAt) resumeAt = until;
          continue;
        }
        if (credential.status === "active" && credential.quota_remaining !== 0) {
          eligible.push(credential);
          continue;
        }
        if (credential.status === "cooldown" && serializedMillis(credential.cooldown_until) <= now) {
          eligible.push(credential);
          continue;
        }
        if (credential.cooldown_until) {
          const until = new Date(serializedMillis(credential.cooldown_until)).toISOString();
          if (!resumeAt || until < resumeAt) resumeAt = until;
        }
        excluded.push(`${profile.model_id}/${credential.label}: ${credential.status}`);
      }
      const selected = selectCredential(route.credential_policy, eligible, request.stickyKey);
      if (selected) {
        const credential = credentials.find((item) => item.credential_id === selected.credential_id);
        if (!credential) continue;
        return {
          status: "selected",
          route,
          candidate,
          profile,
          endpoint,
          credential: credential.status === "cooldown" ? { ...credential, status: "active" } : credential,
          explanation: {
            selected: [
              `candidate=${candidate.candidate_id}`,
              `model=${profile.provider_id}/${profile.model_id}`,
              `credential=${credential.credential_id}`,
              `policy=${route.credential_policy}`,
            ],
            excluded,
          },
        };
      }
      excluded.push(`${profile.model_id}: 사용 가능한 Credential 없음`);
    }
    return {
      status: "blocked_model_unavailable",
      route,
      explanation: { selected: [], excluded },
      ...(resumeAt ? { resumeAt } : {}),
    };
  }

  private profileFailures(route: ModelRoute, profile: ModelProfile, endpoint: ProviderEndpoint): string[] {
    const failures: string[] = [];
    if (!profile.enabled || !profile.verified) failures.push("검증되지 않은 model");
    if (profile.route_kind !== route.route_kind) failures.push("route kind 불일치");
    if (profile.equivalence_group !== route.equivalence_group) failures.push("equivalence group 불일치");
    if (profile.eval_score < route.min_eval_score) failures.push("eval score 부족");
    if (profile.context_window < route.max_context_tokens) failures.push("context window 부족");
    if (route.require_tools && !profile.supports_tools) failures.push("tool capability 없음");
    if (route.require_structured_output && !profile.supports_structured_output) failures.push("structured output 없음");
    if (route.require_vision && !profile.supports_vision) failures.push("vision capability 없음");
    if (route.require_streaming && !profile.supports_streaming) failures.push("streaming capability 없음");
    if (route.data_policy === "local-private" && !endpoint.local) failures.push("외부 endpoint 금지");
    return failures;
  }

  private async reservationFromAttempt(
    executor: QueryExecutor,
    context: TenantContext,
    attempt: RouteAttempt,
    requestJson: string,
  ): Promise<RouteReservation> {
    const explanation = JSON.parse(attempt.explanation_json) as {
      request: string;
      explanation: RouteSimulation["explanation"];
    };
    if (explanation.request !== requestJson) throw new Error("같은 commandId에 다른 route 요청을 사용할 수 없습니다");
    const route = await this.routeById(executor, context.organizationId, attempt.route_id);
    const [candidates] = await executor.query<[RouteCandidate[]]>(
      "SELECT * OMIT id FROM model_route_candidate WHERE organization_id = $organization_id AND candidate_id = $candidate_id LIMIT 1;",
      { organization_id: context.organizationId, candidate_id: attempt.candidate_id },
    );
    const candidate = candidates[0];
    if (!candidate) throw new Error("Attempt Candidate를 찾을 수 없습니다");
    const profile = await this.profile(executor, context.organizationId, attempt.model_profile_id);
    const endpoint = await this.endpoint(executor, context.organizationId, profile.endpoint_id);
    const [credentials] = await executor.query<[ProviderCredential[]]>(
      "SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id AND credential_id = $credential_id LIMIT 1;",
      { organization_id: context.organizationId, credential_id: attempt.credential_id },
    );
    const credential = credentials[0];
    if (!credential) throw new Error("Attempt Credential을 찾을 수 없습니다");
    const secret = await this.providers.resolveExecutionSecretVersion(
      context,
      credential,
      attempt.credential_secret_version,
      executor,
    );
    return {
      status: "selected",
      route,
      candidate,
      profile,
      endpoint,
      credential,
      attempt,
      secret,
      explanation: explanation.explanation,
    };
  }

  private async command<Payload extends object>(
    context: TenantContext,
    commandId: string,
    eventType: string,
    requestJson: string,
    operation: (executor: QueryExecutor) => Promise<Payload>,
  ): Promise<Payload & { audit: RouterAuditEvent }> {
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      const [existing] = await tx.query<[RouterAuditEvent[]]>(
        "SELECT * OMIT id FROM router_audit_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: commandId },
      );
      if (existing[0]) {
        if (existing[0].request_json !== requestJson)
          throw new Error("같은 commandId에 다른 명령을 사용할 수 없습니다");
        return JSON.parse(existing[0].result_json) as Payload & { audit: RouterAuditEvent };
      }
      const payload = await operation(tx);
      const [events] = await tx.query<[RouterAuditEvent[]]>(
        "CREATE router_audit_event CONTENT { audit_event_id: $audit_id, organization_id: $organization_id, command_id: $command_id, event_type: $event_type, actor_user_id: $actor_user_id, request_json: $request_json, result_json: '{}', created_at: time::now() } RETURN AFTER;",
        {
          audit_id: randomUUID(),
          organization_id: context.organizationId,
          command_id: commandId,
          event_type: eventType,
          actor_user_id: context.userId,
          request_json: requestJson,
        },
      );
      const audit = events[0];
      if (!audit) throw new Error("Router audit event 생성 결과가 없습니다");
      const result = { ...payload, audit };
      await tx.query("UPDATE router_audit_event SET result_json = $result_json WHERE audit_event_id = $audit_id;", {
        result_json: JSON.stringify(result),
        audit_id: audit.audit_event_id,
      });
      return result;
    });
  }

  private async routeByName(executor: QueryExecutor, organizationId: string, name: string): Promise<ModelRoute> {
    const [routes] = await executor.query<[ModelRoute[]]>(
      "SELECT * OMIT id FROM model_route WHERE organization_id = $organization_id AND name = $name AND enabled = true LIMIT 1;",
      { organization_id: organizationId, name },
    );
    if (!routes[0]) throw new Error(`Model Route를 찾을 수 없습니다: ${name}`);
    return routes[0];
  }

  private async routeById(executor: QueryExecutor, organizationId: string, routeId: string): Promise<ModelRoute> {
    const [routes] = await executor.query<[ModelRoute[]]>(
      "SELECT * OMIT id FROM model_route WHERE organization_id = $organization_id AND route_id = $route_id AND enabled = true LIMIT 1;",
      { organization_id: organizationId, route_id: routeId },
    );
    if (!routes[0]) throw new Error(`Model Route를 찾을 수 없습니다: ${routeId}`);
    return routes[0];
  }

  private async profile(executor: QueryExecutor, organizationId: string, profileId: string): Promise<ModelProfile> {
    const [profiles] = await executor.query<[ModelProfile[]]>(
      "SELECT * OMIT id FROM model_profile WHERE organization_id = $organization_id AND model_profile_id = $profile_id LIMIT 1;",
      { organization_id: organizationId, profile_id: profileId },
    );
    if (!profiles[0]) throw new Error(`Model Profile을 찾을 수 없습니다: ${profileId}`);
    return profiles[0];
  }

  private async endpoint(
    executor: QueryExecutor,
    organizationId: string,
    endpointId: string,
  ): Promise<ProviderEndpoint> {
    const [endpoints] = await executor.query<[ProviderEndpoint[]]>(
      "SELECT * OMIT id FROM provider_endpoint WHERE organization_id = $organization_id AND endpoint_id = $endpoint_id AND enabled = true LIMIT 1;",
      { organization_id: organizationId, endpoint_id: endpointId },
    );
    if (!endpoints[0]) throw new Error(`Provider Endpoint를 찾을 수 없습니다: ${endpointId}`);
    return endpoints[0];
  }

  private async attempt(executor: QueryExecutor, organizationId: string, attemptId: string): Promise<RouteAttempt> {
    const [attempts] = await executor.query<[RouteAttempt[]]>(
      "SELECT * OMIT id FROM route_attempt WHERE organization_id = $organization_id AND attempt_id = $attempt_id LIMIT 1;",
      { organization_id: organizationId, attempt_id: attemptId },
    );
    if (!attempts[0]) throw new Error(`Route Attempt를 찾을 수 없습니다: ${attemptId}`);
    return attempts[0];
  }

  private async circuit(
    executor: QueryExecutor,
    organizationId: string,
    scopeType: CircuitScope,
    scopeId: string,
  ): Promise<RouterCircuit | undefined> {
    const [circuits] = await executor.query<[RouterCircuit[]]>(
      "SELECT * OMIT id FROM router_circuit WHERE organization_id = $organization_id AND scope_type = $scope_type AND scope_id = $scope_id LIMIT 1;",
      { organization_id: organizationId, scope_type: scopeType, scope_id: scopeId },
    );
    return circuits[0];
  }

  private async recordCircuitFailure(
    executor: QueryExecutor,
    organizationId: string,
    scopeType: CircuitScope,
    scopeId: string,
    failureClass: string,
  ): Promise<void> {
    const current = await this.circuit(executor, organizationId, scopeType, scopeId);
    const failureCount = (current?.failure_count ?? 0) + 1;
    const open = failureCount >= 3;
    const openUntil = open ? new Date(Date.now() + 60_000) : undefined;
    if (!current) {
      await executor.query(
        "CREATE router_circuit CONTENT { circuit_id: $circuit_id, organization_id: $organization_id, scope_type: $scope_type, scope_id: $scope_id, state: $state, failure_count: $failure_count, success_count: 0, threshold: 3, open_until: $open_until, last_failure_class: $failure_class, version: 1, created_at: time::now(), updated_at: time::now() };",
        {
          circuit_id: randomUUID(),
          organization_id: organizationId,
          scope_type: scopeType,
          scope_id: scopeId,
          state: open ? "open" : "closed",
          failure_count: failureCount,
          open_until: openUntil,
          failure_class: failureClass,
        },
      );
      return;
    }
    await executor.query(
      "UPDATE router_circuit SET state = $state, failure_count = $failure_count, open_until = $open_until, last_failure_class = $failure_class, version += 1, updated_at = time::now() WHERE organization_id = $organization_id AND circuit_id = $circuit_id;",
      {
        organization_id: organizationId,
        circuit_id: current.circuit_id,
        state: open ? "open" : "closed",
        failure_count: failureCount,
        open_until: openUntil,
        failure_class: failureClass,
      },
    );
  }

  private async recordCircuitSuccess(
    executor: QueryExecutor,
    organizationId: string,
    scopeType: CircuitScope,
    scopeId: string,
  ): Promise<void> {
    const current = await this.circuit(executor, organizationId, scopeType, scopeId);
    if (!current) return;
    await executor.query(
      "UPDATE router_circuit SET state = 'closed', failure_count = 0, success_count += 1, open_until = NONE, last_failure_class = NONE, version += 1, updated_at = time::now() WHERE organization_id = $organization_id AND circuit_id = $circuit_id;",
      { organization_id: organizationId, circuit_id: current.circuit_id },
    );
  }
}
