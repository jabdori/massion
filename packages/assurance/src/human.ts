import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase, QueryExecutor } from "@massion/storage";

import type { HumanAttestation } from "./contracts.js";

export interface RecordHumanAttestationInput {
  readonly commandId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
  readonly criterionId: string;
  readonly statementHash: string;
  readonly snapshotHash: string;
  readonly accepted: boolean;
}

export interface HumanAttestationProgress {
  readonly acceptedCount: number;
  readonly minimumAttestations: number;
  readonly rejected: boolean;
  readonly satisfied: boolean;
}

export interface HumanAttestationResult {
  readonly attestation: HumanAttestation;
  readonly progress: HumanAttestationProgress;
}

interface AttestationRecord {
  readonly attestation_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly assurance_run_id: string;
  readonly criterion_id: string;
  readonly attestor_user_id: string;
  readonly statement_hash: string;
  readonly snapshot_hash: string;
  readonly accepted: boolean;
  readonly command_id: string;
  readonly request_hash: string;
  readonly created_at: unknown;
}

interface RunRecord {
  readonly work_id: string;
  readonly binding_version_id: string;
  readonly snapshot_hash: string;
  readonly status: string;
}

interface CriterionRecord {
  readonly criterion_id: string;
  readonly criterion_key: string;
  readonly statement: string;
  readonly method: string;
}

interface BindingRecord {
  readonly status: string;
  readonly bindings_json: string;
}

interface HumanBinding {
  readonly kind: "human";
  readonly criterionKey: string;
  readonly eligibleRoles: readonly string[];
  readonly minimumAttestations: number;
}

interface HumanTarget {
  readonly binding: HumanBinding;
}

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: string, label: string, maximum = 200): void {
  if (!value.trim()) throw new Error(`${label}이 필요합니다`);
  if (value.length > maximum) throw new Error(`${label}은 ${String(maximum)}자 이하여야 합니다`);
}

function hash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}는 SHA-256 형식이어야 합니다`);
}

function isoDateTime(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "toISOString" in value
        ? String((value as { toISOString(): unknown }).toISOString())
        : undefined;
  if (!raw) throw new Error("HumanAttestation createdAt을 직렬화할 수 없습니다");
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error("HumanAttestation createdAt이 올바르지 않습니다");
  return parsed.toISOString();
}

function view(record: AttestationRecord): HumanAttestation {
  return {
    attestationId: record.attestation_id,
    organizationId: record.organization_id,
    workId: record.work_id,
    assuranceRunId: record.assurance_run_id,
    criterionId: record.criterion_id,
    attestorUserId: record.attestor_user_id,
    statementHash: record.statement_hash,
    snapshotHash: record.snapshot_hash,
    accepted: record.accepted,
    commandId: record.command_id,
    requestHash: record.request_hash,
    createdAt: isoDateTime(record.created_at),
  };
}

function isHumanBinding(value: unknown): value is HumanBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "human" &&
    typeof candidate.criterionKey === "string" &&
    Array.isArray(candidate.eligibleRoles) &&
    candidate.eligibleRoles.every((role) => typeof role === "string") &&
    Number.isSafeInteger(candidate.minimumAttestations) &&
    Number(candidate.minimumAttestations) >= 1 &&
    Number(candidate.minimumAttestations) <= 10
  );
}

export class HumanAttestationStore {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async record(context: TenantContext, input: RecordHumanAttestationInput): Promise<HumanAttestationResult> {
    if ("attestorUserId" in (input as unknown as Record<string, unknown>)) {
      throw new Error("Human attestor는 caller가 지정할 수 없습니다");
    }
    await this.organizations.verifyTenantContext(context);
    this.validateInput(input);
    const requestHash = sha256(
      canonicalJson({ operation: "record_human_attestation", input, attestorUserId: context.userId }),
    );
    const replayed = await this.replay(context.organizationId, input.commandId, requestHash, this.database);
    if (replayed) {
      const target = await this.verifyTarget(this.database, context, input);
      return {
        attestation: view(replayed),
        progress: await this.progress(
          this.database,
          context.organizationId,
          input.assuranceRunId,
          input.criterionId,
          target,
        ),
      };
    }

    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrent = await this.replay(context.organizationId, input.commandId, requestHash, transaction);
      const target = await this.verifyTarget(transaction, context, input);
      if (concurrent) {
        return {
          attestation: view(concurrent),
          progress: await this.progress(
            transaction,
            context.organizationId,
            input.assuranceRunId,
            input.criterionId,
            target,
          ),
        };
      }
      const [existing] = await transaction.query<[AttestationRecord[]]>(
        "SELECT * OMIT id FROM assurance_human_attestation WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id AND attestor_user_id = $attestor_user_id LIMIT 1;",
        {
          organization_id: context.organizationId,
          assurance_run_id: input.assuranceRunId,
          criterion_id: input.criterionId,
          attestor_user_id: context.userId,
        },
      );
      if (existing[0]) throw new Error("한 사용자는 같은 Assurance criterion에 한 번만 attestation할 수 있습니다");

      const attestationId = randomUUID();
      const [records] = await transaction.query<[AttestationRecord[]]>(
        "CREATE assurance_human_attestation CONTENT { attestation_id: $attestation_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, attestor_user_id: $attestor_user_id, statement_hash: $statement_hash, snapshot_hash: $snapshot_hash, accepted: $accepted, command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
        {
          attestation_id: attestationId,
          organization_id: context.organizationId,
          work_id: input.workId,
          assurance_run_id: input.assuranceRunId,
          criterion_id: input.criterionId,
          attestor_user_id: context.userId,
          statement_hash: input.statementHash,
          snapshot_hash: input.snapshotHash,
          accepted: input.accepted,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      const created = records[0];
      if (!created) throw new Error("HumanAttestation 생성 결과가 없습니다");
      await this.recordEvent(transaction, context, input, requestHash, attestationId);
      return {
        attestation: view(created),
        progress: await this.progress(
          transaction,
          context.organizationId,
          input.assuranceRunId,
          input.criterionId,
          target,
        ),
      };
    });
  }

  private validateInput(input: RecordHumanAttestationInput): void {
    text(input.commandId, "Human attestation command ID");
    text(input.workId, "Work ID");
    text(input.assuranceRunId, "Assurance run ID");
    text(input.criterionId, "Assurance criterion ID");
    hash(input.statementHash, "Human attestation statement hash");
    hash(input.snapshotHash, "Human attestation snapshot hash");
    if (typeof input.accepted !== "boolean") throw new Error("Human attestation accepted는 boolean이어야 합니다");
  }

  private async replay(
    organizationId: string,
    commandId: string,
    requestHash: string,
    executor: QueryExecutor,
  ): Promise<AttestationRecord | undefined> {
    const [records] = await executor.query<[AttestationRecord[]]>(
      "SELECT * OMIT id FROM assurance_human_attestation WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    const record = records[0];
    if (record && record.request_hash !== requestHash) {
      throw new Error("같은 commandId를 다른 HumanAttestation payload에 재사용할 수 없습니다");
    }
    return record;
  }

  private async verifyTarget(
    executor: QueryExecutor,
    context: TenantContext,
    input: RecordHumanAttestationInput,
  ): Promise<HumanTarget> {
    const [runs] = await executor.query<[RunRecord[]]>(
      "SELECT work_id, binding_version_id, snapshot_hash, status FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      {
        organization_id: context.organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
      },
    );
    const run = runs[0];
    if (!run || !["planned", "running"].includes(run.status)) {
      throw new Error("활성 Assurance run을 찾을 수 없습니다");
    }
    if (run.snapshot_hash !== input.snapshotHash) {
      throw new Error("Human attestation snapshot hash가 Assurance run snapshot과 다릅니다");
    }
    const [criteria] = await executor.query<[CriterionRecord[]]>(
      "SELECT criterion_id, criterion_key, statement, method FROM assurance_criterion WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id LIMIT 1;",
      {
        organization_id: context.organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
        criterion_id: input.criterionId,
      },
    );
    const criterion = criteria[0];
    if (!criterion || criterion.method !== "human") throw new Error("Human Assurance criterion을 찾을 수 없습니다");
    if (sha256(criterion.statement) !== input.statementHash) {
      throw new Error("Human attestation statement hash가 현재 criterion 문장과 다릅니다");
    }
    const [bindings] = await executor.query<[BindingRecord[]]>(
      "SELECT status, bindings_json FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id AND binding_version_id = $binding_version_id AND status IN ['active', 'superseded'] LIMIT 1;",
      {
        organization_id: context.organizationId,
        work_id: input.workId,
        binding_version_id: run.binding_version_id,
      },
    );
    const bindingVersion = bindings[0];
    if (!bindingVersion) throw new Error("Assurance run의 활성 또는 superseded binding을 찾을 수 없습니다");
    let decoded: unknown;
    try {
      decoded = JSON.parse(bindingVersion.bindings_json) as unknown;
    } catch {
      throw new Error("Assurance binding JSON이 올바르지 않습니다");
    }
    if (!Array.isArray(decoded)) throw new Error("Assurance binding 목록이 올바르지 않습니다");
    const binding = decoded.find(
      (candidate): candidate is HumanBinding =>
        isHumanBinding(candidate) && candidate.criterionKey === criterion.criterion_key,
    );
    if (!binding) throw new Error("Criterion에 대응하는 Human binding을 찾을 수 없습니다");
    if (!binding.eligibleRoles.includes(context.role)) {
      throw new Error(`현재 Membership은 Human binding의 eligible role이 아닙니다: ${context.role}`);
    }
    return { binding };
  }

  private async progress(
    executor: QueryExecutor,
    organizationId: string,
    assuranceRunId: string,
    criterionId: string,
    target: HumanTarget,
  ): Promise<HumanAttestationProgress> {
    const [records] = await executor.query<[{ accepted: boolean }[]]>(
      "SELECT accepted FROM assurance_human_attestation WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id;",
      { organization_id: organizationId, assurance_run_id: assuranceRunId, criterion_id: criterionId },
    );
    const acceptedCount = records.filter((record) => record.accepted).length;
    const rejected = records.some((record) => !record.accepted);
    return {
      acceptedCount,
      minimumAttestations: target.binding.minimumAttestations,
      rejected,
      satisfied: !rejected && acceptedCount >= target.binding.minimumAttestations,
    };
  }

  private async recordEvent(
    executor: QueryExecutor,
    context: TenantContext,
    input: RecordHumanAttestationInput,
    requestHash: string,
    attestationId: string,
  ): Promise<void> {
    const [events] = await executor.query<[{ sequence: number }[]]>(
      "SELECT sequence FROM assurance_event WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
      { organization_id: context.organizationId, assurance_run_id: input.assuranceRunId },
    );
    const sequence = events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    await executor.query(
      "CREATE assurance_event CONTENT { event_id: $event_id, organization_id: $organization_id, assurance_run_id: $assurance_run_id, command_id: $command_id, sequence: $sequence, event_type: 'assurance_attestation_recorded', request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        assurance_run_id: input.assuranceRunId,
        command_id: input.commandId,
        sequence,
        request_hash: requestHash,
        payload_json: canonicalJson({ attestationId, criterionId: input.criterionId, accepted: input.accepted }),
        actor_user_id: context.userId,
      },
    );
  }
}
