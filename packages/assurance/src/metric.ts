import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase, QueryExecutor } from "@massion/storage";

import type { MetricObservation } from "./contracts.js";

export interface MetricObservationInput {
  readonly commandId: string;
  readonly workId: string;
  readonly producer:
    | { readonly kind: "runtime_execution"; readonly id: string }
    | { readonly kind: "system_adapter"; readonly id: string };
  readonly source:
    | { readonly kind: "artifact_version"; readonly id: string }
    | { readonly kind: "runtime_execution"; readonly id: string };
  readonly expectedUnit: string;
  readonly maximumAgeMs: number;
}

export interface MetricObservationReadInput extends MetricObservationInput {
  readonly organizationId: string;
}

export interface MetricObservationReadResult {
  readonly value: number;
  readonly unit: string;
  readonly measuredAt: string;
  readonly sourceChecksum: string;
  readonly checksum: string;
}

export interface MetricObservationReader {
  observe(executor: QueryExecutor, input: MetricObservationReadInput): Promise<MetricObservationReadResult>;
}

interface MetricObservationRecord {
  readonly observation_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly producer_kind: MetricObservation["producerKind"];
  readonly producer_id: string;
  readonly source_kind: MetricObservation["sourceKind"];
  readonly source_id: string;
  readonly numeric_value: number;
  readonly unit: string;
  readonly checksum: string;
  readonly source_checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly measured_at: unknown;
  readonly created_at: unknown;
}

interface ArtifactSourceRecord {
  readonly checksum: string;
  readonly content_json: string;
}

interface RuntimeSourceRecord {
  readonly output_json?: string;
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

export function metricObservationChecksum(value: unknown): string {
  return sha256(canonicalJson(value));
}

function text(value: string, label: string, maximum = 200): void {
  if (!value.trim()) throw new Error(`${label}이 필요합니다`);
  if (value.length > maximum) throw new Error(`${label}은 ${String(maximum)}자 이하여야 합니다`);
}

function isoDateTime(value: unknown, label: string): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "toISOString" in value
        ? String((value as { toISOString(): unknown }).toISOString())
        : undefined;
  if (!raw) throw new Error(`${label}을 직렬화할 수 없습니다`);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}이 올바르지 않습니다`);
  return parsed.toISOString();
}

function validateInput(input: MetricObservationInput): void {
  text(input.commandId, "Metric command ID");
  text(input.workId, "Work ID");
  text(input.producer.id, "Metric producer ID");
  text(input.source.id, "Metric source ID");
  text(input.expectedUnit, "Metric expected unit", 100);
  if (!Number.isSafeInteger(input.maximumAgeMs) || input.maximumAgeMs < 0) {
    throw new Error("Metric freshness 상한이 올바르지 않습니다");
  }
}

function view(record: MetricObservationRecord): MetricObservation {
  return {
    observationId: record.observation_id,
    organizationId: record.organization_id,
    workId: record.work_id,
    producerKind: record.producer_kind,
    producerId: record.producer_id,
    sourceKind: record.source_kind,
    sourceId: record.source_id,
    value: record.numeric_value,
    unit: record.unit,
    checksum: record.checksum,
    measuredAt: isoDateTime(record.measured_at, "Metric measuredAt"),
    createdAt: isoDateTime(record.created_at, "Metric createdAt"),
  };
}

export class MetricObservationStore {
  private readonly systemAdapters: Readonly<Record<string, MetricObservationReader>>;
  private readonly runtimeExecutionReader: MetricObservationReader | undefined;
  private readonly clock: () => Date;

  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    options: {
      readonly systemAdapters: Readonly<Record<string, MetricObservationReader>>;
      readonly runtimeExecutionReader?: MetricObservationReader;
      readonly clock?: () => Date;
    },
  ) {
    this.systemAdapters = { ...options.systemAdapters };
    this.runtimeExecutionReader = options.runtimeExecutionReader;
    this.clock = options.clock ?? (() => new Date());
  }

  public async record(context: TenantContext, input: MetricObservationInput): Promise<MetricObservation> {
    if ("value" in (input as unknown as Record<string, unknown>)) {
      throw new Error("Metric caller raw value는 허용되지 않습니다");
    }
    await this.organizations.verifyTenantContext(context);
    validateInput(input);
    const requestHash = sha256(canonicalJson({ operation: "record_metric_observation", input }));
    const replayed = await this.replay(context.organizationId, input.commandId, requestHash, this.database);
    if (replayed) return view(replayed);

    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrent = await this.replay(context.organizationId, input.commandId, requestHash, transaction);
      if (concurrent) return view(concurrent);

      await this.verifyWork(transaction, context.organizationId, input.workId);
      await this.verifyProducer(transaction, context.organizationId, input);
      const sourceChecksum = await this.verifySource(transaction, context.organizationId, input);
      const readInput: MetricObservationReadInput = { ...input, organizationId: context.organizationId };
      const reader = this.reader(input);
      const observed = await reader.observe(transaction, readInput);
      this.verifyObservation(readInput, observed, sourceChecksum);

      const [records] = await transaction.query<[MetricObservationRecord[]]>(
        "CREATE assurance_metric_observation CONTENT { observation_id: $observation_id, organization_id: $organization_id, work_id: $work_id, producer_kind: $producer_kind, producer_id: $producer_id, source_kind: $source_kind, source_id: $source_id, numeric_value: $numeric_value, unit: $unit, checksum: $checksum, source_checksum: $source_checksum, command_id: $command_id, request_hash: $request_hash, measured_at: $measured_at, created_at: time::now() } RETURN AFTER;",
        {
          observation_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: input.workId,
          producer_kind: input.producer.kind,
          producer_id: input.producer.id,
          source_kind: input.source.kind,
          source_id: input.source.id,
          numeric_value: observed.value,
          unit: observed.unit,
          checksum: observed.checksum,
          source_checksum: observed.sourceChecksum,
          command_id: input.commandId,
          request_hash: requestHash,
          measured_at: new Date(observed.measuredAt),
        },
      );
      const created = records[0];
      if (!created) throw new Error("MetricObservation 생성 결과가 없습니다");
      return view(created);
    });
  }

  private async replay(
    organizationId: string,
    commandId: string,
    requestHash: string,
    executor: QueryExecutor,
  ): Promise<MetricObservationRecord | undefined> {
    const [records] = await executor.query<[MetricObservationRecord[]]>(
      "SELECT * OMIT id FROM assurance_metric_observation WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    const record = records[0];
    if (record && record.request_hash !== requestHash) {
      throw new Error("같은 commandId를 다른 MetricObservation payload에 재사용할 수 없습니다");
    }
    return record;
  }

  private async verifyWork(executor: QueryExecutor, organizationId: string, workId: string): Promise<void> {
    const [works] = await executor.query<[{ work_id: string }[]]>(
      "SELECT work_id FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
      { organization_id: organizationId, work_id: workId },
    );
    if (!works[0]) throw new Error("MetricObservation 대상 Work를 찾을 수 없습니다");
  }

  private async verifyProducer(
    executor: QueryExecutor,
    organizationId: string,
    input: MetricObservationInput,
  ): Promise<void> {
    if (input.producer.kind === "system_adapter") {
      if (!this.systemAdapters[input.producer.id]) {
        throw new Error(`trusted Metric system adapter가 아닙니다: ${input.producer.id}`);
      }
      return;
    }
    const [executions] = await executor.query<[{ execution_id: string }[]]>(
      "SELECT execution_id FROM runtime_execution WHERE organization_id = $organization_id AND work_id = $work_id AND execution_id = $execution_id AND status = 'succeeded' LIMIT 1;",
      { organization_id: organizationId, work_id: input.workId, execution_id: input.producer.id },
    );
    if (!executions[0]) throw new Error("trusted succeeded Runtime execution producer를 찾을 수 없습니다");
  }

  private reader(input: MetricObservationInput): MetricObservationReader {
    if (input.producer.kind === "system_adapter") {
      const reader = this.systemAdapters[input.producer.id];
      if (!reader) throw new Error(`trusted Metric system adapter reader가 없습니다: ${input.producer.id}`);
      return reader;
    }
    if (!this.runtimeExecutionReader) throw new Error("trusted Runtime Metric reader가 등록되지 않았습니다");
    return this.runtimeExecutionReader;
  }

  private async verifySource(
    executor: QueryExecutor,
    organizationId: string,
    input: MetricObservationInput,
  ): Promise<string> {
    if (input.source.kind === "artifact_version") {
      const [artifacts] = await executor.query<[ArtifactSourceRecord[]]>(
        "SELECT checksum, content_json FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id = $artifact_version_id LIMIT 1;",
        { organization_id: organizationId, work_id: input.workId, artifact_version_id: input.source.id },
      );
      const artifact = artifacts[0];
      if (!artifact) throw new Error("같은 organization과 Work의 Metric artifact source를 찾을 수 없습니다");
      if (sha256(artifact.content_json) !== artifact.checksum) {
        throw new Error("Metric artifact source checksum이 저장 내용과 일치하지 않습니다");
      }
      return artifact.checksum;
    }
    const [executions] = await executor.query<[RuntimeSourceRecord[]]>(
      "SELECT output_json FROM runtime_execution WHERE organization_id = $organization_id AND work_id = $work_id AND execution_id = $execution_id AND status = 'succeeded' LIMIT 1;",
      { organization_id: organizationId, work_id: input.workId, execution_id: input.source.id },
    );
    const execution = executions[0];
    if (!execution?.output_json)
      throw new Error("같은 organization과 Work의 succeeded Runtime source를 찾을 수 없습니다");
    return sha256(execution.output_json);
  }

  private verifyObservation(
    input: MetricObservationReadInput,
    observed: MetricObservationReadResult,
    sourceChecksum: string,
  ): void {
    if (!Number.isFinite(observed.value) || Math.abs(observed.value) >= 9_000_000_000_000_000_000) {
      throw new Error("Metric observation value는 지원 범위 안의 유한한 수여야 합니다");
    }
    if (observed.unit !== input.expectedUnit) throw new Error("Metric observation unit이 binding 단위와 다릅니다");
    const measuredAt = new Date(observed.measuredAt).getTime();
    if (!Number.isFinite(measuredAt)) throw new Error("Metric observation measuredAt이 올바르지 않습니다");
    const now = this.clock().getTime();
    if (measuredAt > now) throw new Error("Metric observation은 현재보다 미래일 수 없습니다");
    if (now - measuredAt > input.maximumAgeMs) throw new Error("Metric observation freshness 상한을 초과했습니다");
    if (observed.sourceChecksum !== sourceChecksum) {
      throw new Error("Metric observation source checksum이 실제 source와 다릅니다");
    }
    const checksum = metricObservationChecksum({
      ...input,
      value: observed.value,
      unit: observed.unit,
      measuredAt: observed.measuredAt,
      sourceChecksum: observed.sourceChecksum,
    });
    if (observed.checksum !== checksum) throw new Error("Metric observation checksum이 관측 payload와 다릅니다");
  }
}
