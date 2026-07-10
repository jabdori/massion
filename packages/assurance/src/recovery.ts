import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import { WorkAssurancePort, type ProjectAssuranceVerdictInput } from "@massion/work";

import type { AssuranceRun } from "./contracts.js";
import { AssuranceMetricStore, type AssuranceRecoveryMetricResult } from "./metrics.js";
import { AssuranceRunStore } from "./run-store.js";
import { ASSURANCE_RECOVERY_METRIC_MIGRATION } from "./schema.js";
import { AssuranceService, DatabaseAssuranceDecisionSource, type DecideAssuranceInput } from "./service.js";
import { AssuranceRunVerdictReader } from "./work-verdict-reader.js";

export type AssuranceRecoveryResult = AssuranceRecoveryMetricResult;

export interface AssuranceRecoveryGateway {
  get(context: TenantContext, assuranceRunId: string): Promise<AssuranceRun>;
  decide(context: TenantContext, input: DecideAssuranceInput): Promise<{ readonly run: AssuranceRun }>;
}

export interface AssuranceRecoveryProjectionGateway {
  projectVerdict(context: TenantContext, input: ProjectAssuranceVerdictInput): Promise<unknown>;
}

export interface AssuranceRecoveryReadiness {
  readonly snapshotFresh: boolean;
  readonly storedResultsValid: boolean;
  readonly evidenceComplete: boolean;
}

export interface AssuranceRecoveryReadinessSource {
  inspect(context: TenantContext, assuranceRunId: string): Promise<AssuranceRecoveryReadiness>;
}

export interface AssuranceRecoveryContinuation {
  resume(context: TenantContext, run: AssuranceRun): Promise<void>;
}

export interface AssuranceRecoveryLedger {
  replay(
    context: TenantContext,
    input: { readonly commandId: string; readonly assuranceRunId: string },
  ): Promise<{ readonly assuranceRunId: string; readonly result: string } | undefined>;
  record(
    context: TenantContext,
    input: { readonly commandId: string; readonly assuranceRunId: string; readonly result: AssuranceRecoveryResult },
  ): Promise<void>;
}

export interface AssuranceRecoveryMetricSink {
  recordOnce(
    context: TenantContext,
    key: string,
    input: {
      readonly name: "assurance_recovery_total";
      readonly value: number;
      readonly dimensions: { readonly result: AssuranceRecoveryResult };
    },
  ): Promise<void>;
  recordRun?(context: TenantContext, assuranceRunId: string): Promise<void>;
}

interface RecoveryDependencies {
  readonly gateway: AssuranceRecoveryGateway;
  readonly projection: AssuranceRecoveryProjectionGateway;
  readonly readiness: AssuranceRecoveryReadinessSource;
  readonly ledger: AssuranceRecoveryLedger;
  readonly metrics: AssuranceRecoveryMetricSink;
  readonly continuation?: AssuranceRecoveryContinuation;
  readonly now: () => Date;
}

interface RecoveryEventRecord {
  readonly assurance_run_id: string;
  readonly request_hash: string;
  readonly payload_json: string;
}

const TERMINAL = new Set<AssuranceRun["status"]>(["passed", "failed", "blocked", "cancelled"]);
const RESULTS = new Set<AssuranceRecoveryResult>([
  "resumed",
  "resume_required",
  "blocked",
  "projected",
  "terminal_unchanged",
]);

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function recoveryRequestHash(assuranceRunId: string): string {
  return createHash("sha256")
    .update(canonicalJson({ operation: "assurance_recovery", assuranceRunId }))
    .digest("hex");
}

function assertText(value: string, label: string): void {
  if (!value.trim() || value.length > 200) throw new Error(`${label}가 필요합니다`);
}

class DatabaseAssuranceRecoveryReadiness implements AssuranceRecoveryReadinessSource {
  public constructor(private readonly source: DatabaseAssuranceDecisionSource) {}

  public async inspect(context: TenantContext, assuranceRunId: string): Promise<AssuranceRecoveryReadiness> {
    const state = await this.source.read(context, assuranceRunId);
    const storedResultsValid = state.decisionInput.checks.every((check) => {
      if (check.status === "pending" || check.status === "running") return true;
      if (check.status === "cancelled") return true;
      return typeof check.outputHash === "string" && /^[a-f0-9]{64}$/u.test(check.outputHash);
    });
    return {
      snapshotFresh: state.decisionInput.snapshotStatus === "fresh",
      storedResultsValid,
      evidenceComplete: state.decisionInput.requiredEvidenceComplete,
    };
  }
}

class DatabaseAssuranceRecoveryLedger implements AssuranceRecoveryLedger {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async replay(
    context: TenantContext,
    input: { readonly commandId: string; readonly assuranceRunId: string },
  ): Promise<{ readonly assuranceRunId: string; readonly result: string } | undefined> {
    await this.organizations.verifyTenantContext(context);
    const [events] = await this.database.query<[RecoveryEventRecord[]]>(
      "SELECT assurance_run_id, request_hash, payload_json FROM assurance_event WHERE organization_id = $organization_id AND command_id = $command_id AND event_type = 'assurance_run_recovered' LIMIT 1;",
      { organization_id: context.organizationId, command_id: input.commandId },
    );
    const event = events[0];
    if (!event) return undefined;
    if (
      event.request_hash !== recoveryRequestHash(input.assuranceRunId) ||
      event.assurance_run_id !== input.assuranceRunId
    ) {
      throw new Error("같은 command ID에 다른 Assurance recovery 명령을 사용할 수 없습니다");
    }
    const payload = JSON.parse(event.payload_json) as { readonly result?: string };
    if (!payload.result || !RESULTS.has(payload.result as AssuranceRecoveryResult)) {
      throw new Error("Assurance recovery replay 결과가 유효하지 않습니다");
    }
    return { assuranceRunId: event.assurance_run_id, result: payload.result };
  }

  public async record(
    context: TenantContext,
    input: { readonly commandId: string; readonly assuranceRunId: string; readonly result: AssuranceRecoveryResult },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = recoveryRequestHash(input.assuranceRunId);
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await this.findEvent(transaction, context.organizationId, input.commandId);
      if (repeated) {
        if (repeated.request_hash !== requestHash || repeated.assurance_run_id !== input.assuranceRunId) {
          throw new Error("같은 command ID에 다른 Assurance recovery 명령을 사용할 수 없습니다");
        }
        const payload = JSON.parse(repeated.payload_json) as { readonly result?: string };
        if (payload.result !== input.result) throw new Error("Assurance recovery replay 결과가 다릅니다");
        return;
      }
      const [runs] = await transaction.query<[{ assurance_run_id: string }[]]>(
        "SELECT assurance_run_id FROM assurance_run WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
        { organization_id: context.organizationId, assurance_run_id: input.assuranceRunId },
      );
      if (!runs[0]) throw new Error(`Assurance run을 찾을 수 없습니다: ${input.assuranceRunId}`);
      const [events] = await transaction.query<[{ sequence: number }[]]>(
        "SELECT sequence FROM assurance_event WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
        { organization_id: context.organizationId, assurance_run_id: input.assuranceRunId },
      );
      const sequence = events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
      await transaction.query(
        "CREATE assurance_event CONTENT { event_id: $event_id, organization_id: $organization_id, assurance_run_id: $assurance_run_id, command_id: $command_id, sequence: $sequence, event_type: 'assurance_run_recovered', request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          assurance_run_id: input.assuranceRunId,
          command_id: input.commandId,
          sequence,
          request_hash: requestHash,
          payload_json: canonicalJson({ result: input.result }),
          actor_user_id: context.userId,
        },
      );
    });
  }

  private async findEvent(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
  ): Promise<RecoveryEventRecord | undefined> {
    const [events] = await executor.query<[RecoveryEventRecord[]]>(
      "SELECT assurance_run_id, request_hash, payload_json FROM assurance_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return events[0];
  }
}

export class AssuranceRecovery {
  public constructor(private readonly dependencies: RecoveryDependencies) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    options: { readonly continuation?: AssuranceRecoveryContinuation; readonly now?: () => Date } = {},
  ): Promise<AssuranceRecovery> {
    await applyMigrations(database, [ASSURANCE_RECOVERY_METRIC_MIGRATION]);
    const runs = await AssuranceRunStore.create(database, organizations);
    const service = await AssuranceService.create(database, organizations);
    const source = new DatabaseAssuranceDecisionSource(database, organizations, runs);
    return new AssuranceRecovery({
      gateway: {
        get: runs.get.bind(runs),
        decide: service.decide.bind(service),
      },
      projection: new WorkAssurancePort(database, organizations, new AssuranceRunVerdictReader()),
      readiness: new DatabaseAssuranceRecoveryReadiness(source),
      ledger: new DatabaseAssuranceRecoveryLedger(database, organizations),
      metrics: await AssuranceMetricStore.create(database, organizations),
      ...(options.continuation ? { continuation: options.continuation } : {}),
      now: options.now ?? (() => new Date()),
    });
  }

  public async recover(
    context: TenantContext,
    input: { readonly commandId: string; readonly assuranceRunId: string },
  ): Promise<{ readonly run: AssuranceRun; readonly result: AssuranceRecoveryResult }> {
    assertText(input.commandId, "Assurance recovery command ID");
    assertText(input.assuranceRunId, "Assurance recovery run ID");
    const replayed = await this.dependencies.ledger.replay(context, input);
    if (replayed) {
      if (!RESULTS.has(replayed.result as AssuranceRecoveryResult)) {
        throw new Error("Assurance recovery replay 결과가 유효하지 않습니다");
      }
      return {
        run: await this.dependencies.gateway.get(context, replayed.assuranceRunId),
        result: replayed.result as AssuranceRecoveryResult,
      };
    }

    let run = await this.dependencies.gateway.get(context, input.assuranceRunId);
    if (run.organizationId !== context.organizationId || run.assuranceRunId !== input.assuranceRunId) {
      throw new Error("Assurance recovery run 계보가 tenant와 일치하지 않습니다");
    }

    const terminalAtStart = TERMINAL.has(run.status);
    let resumed = false;
    if (!TERMINAL.has(run.status)) {
      const readiness = await this.dependencies.readiness.inspect(context, run.assuranceRunId);
      const expired = new Date(run.expiresAt).getTime() <= this.dependencies.now().getTime();
      if (
        expired &&
        readiness.snapshotFresh &&
        readiness.storedResultsValid &&
        !readiness.evidenceComplete &&
        this.dependencies.continuation
      ) {
        await this.dependencies.continuation.resume(context, run);
        resumed = true;
        run = await this.dependencies.gateway.get(context, run.assuranceRunId);
      }
      if (!TERMINAL.has(run.status)) {
        // 만료 run은 반드시 판정해 active guard를 해제합니다. 만료 전에는 완전한 증거가 이미
        // 저장된 경우에만 같은 결정론적 명령으로 안전하게 판정합니다.
        if (expired || readiness.evidenceComplete || resumed) {
          run = (
            await this.dependencies.gateway.decide(context, {
              commandId: `${run.assuranceRunId}:recovery-decision`,
              assuranceRunId: run.assuranceRunId,
              expectedVersion: run.version,
            })
          ).run;
        }
      }
    }

    let result: AssuranceRecoveryResult;
    if ((run.status === "passed" || run.status === "failed") && run.projectedWorkRevision === undefined) {
      await this.dependencies.projection.projectVerdict(context, {
        commandId: `${run.assuranceRunId}:${run.status === "failed" ? "work-failed" : "work-verification"}`,
        workId: run.workId,
        expectedRevision: run.targetWorkRevision,
        assuranceRunId: run.assuranceRunId,
      });
      run = await this.dependencies.gateway.get(context, run.assuranceRunId);
      result = "projected";
    } else if ((run.status === "passed" || run.status === "failed") && run.projectedWorkRevision !== undefined) {
      result = "projected";
    } else if (run.status === "blocked") {
      result = terminalAtStart ? "terminal_unchanged" : "blocked";
    } else if (run.status === "cancelled") {
      result = "terminal_unchanged";
    } else if (resumed) {
      result = "resumed";
    } else if (!TERMINAL.has(run.status)) {
      result = "resume_required";
    } else {
      result = "terminal_unchanged";
    }

    await this.dependencies.metrics.recordOnce(context, `recovery:${input.commandId}`, {
      name: "assurance_recovery_total",
      value: 1,
      dimensions: { result },
    });
    if (TERMINAL.has(run.status)) await this.dependencies.metrics.recordRun?.(context, run.assuranceRunId);
    await this.dependencies.ledger.record(context, { ...input, result });
    return { run, result };
  }
}

/** 패키지 공개 API에 노출하지 않는 recovery unit test seam입니다. */
export function createAssuranceRecoveryTestHarness(dependencies: RecoveryDependencies): AssuranceRecovery {
  return new AssuranceRecovery(dependencies);
}
