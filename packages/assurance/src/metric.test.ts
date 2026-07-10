import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  AssuranceBootstrap,
  MetricObservationStore,
  metricObservationChecksum,
  type MetricObservationReader,
} from "./index.js";

describe("Assurance MetricObservation", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let otherContext: TenantContext;
  let workId: string;
  let artifactVersionId: string;
  let artifactChecksum: string;
  let store: MetricObservationStore;
  let outputChange: Partial<Awaited<ReturnType<MetricObservationReader["observe"]>>>;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "metric@example.com", displayName: "Metric" });
    const other = await identity.registerPersonalUser({ email: "metric-other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    await AssuranceBootstrap.create(database, organizations);
    const works = await WorkService.create(database, organizations);
    const created = await works.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "metric source",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });
    workId = created.work.work_id;
    const artifact = await works.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: created.work.revision,
      kind: "metric-source",
      name: "coverage.json",
      mediaType: "application/json",
      content: { coverage: 98.5 },
    });
    artifactVersionId = artifact.artifactVersion.artifact_version_id;
    artifactChecksum = artifact.artifactVersion.checksum;
    outputChange = {};
    store = new MetricObservationStore(database, organizations, {
      systemAdapters: { "massion.metric.coverage.v1": reader() },
      clock: () => new Date("2026-07-10T12:00:00.000Z"),
    });
  });

  afterEach(async () => database.close());

  function reader(): MetricObservationReader {
    return {
      async observe(_executor, input) {
        const value = 98.5;
        const unit = "percent";
        const measuredAt = "2026-07-10T11:59:30.000Z";
        return {
          value,
          unit,
          measuredAt,
          sourceChecksum: artifactChecksum,
          checksum: metricObservationChecksum({ ...input, value, unit, measuredAt, sourceChecksum: artifactChecksum }),
          ...outputChange,
        };
      },
    };
  }

  function input(commandId = crypto.randomUUID()) {
    return {
      commandId,
      workId,
      producer: { kind: "system_adapter" as const, id: "massion.metric.coverage.v1" },
      source: { kind: "artifact_version" as const, id: artifactVersionId },
      expectedUnit: "percent",
      maximumAgeMs: 60_000,
    };
  }

  it("trusted adapter가 같은 Work source에서 읽은 유한 관측값만 기록한다", async () => {
    const observation = await store.record(context, input());

    expect(observation).toMatchObject({
      organizationId: context.organizationId,
      workId,
      producerKind: "system_adapter",
      producerId: "massion.metric.coverage.v1",
      sourceKind: "artifact_version",
      sourceId: artifactVersionId,
      value: 98.5,
      unit: "percent",
      measuredAt: "2026-07-10T11:59:30.000Z",
    });
    expect(observation.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("같은 command는 같은 observation을 재생하고 payload 충돌을 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await store.record(context, input(commandId));
    outputChange = { value: 50 };
    const replayed = await store.record(context, input(commandId));

    expect(replayed.observationId).toBe(first.observationId);
    await expect(store.record(context, { ...input(commandId), expectedUnit: "ratio" })).rejects.toThrow(
      "같은 commandId",
    );
  });

  it.each([
    ["untrusted producer", { producer: { kind: "system_adapter" as const, id: "unknown" } }, {}, "trusted"],
    ["unit mismatch", {}, { unit: "ratio" }, "unit"],
    ["NaN", {}, { value: Number.NaN }, "유한"],
    ["Infinity", {}, { value: Number.POSITIVE_INFINITY }, "유한"],
    ["stale", {}, { measuredAt: "2026-07-10T11:00:00.000Z" }, "freshness"],
    ["future", {}, { measuredAt: "2026-07-10T12:00:01.000Z" }, "미래"],
    ["source checksum", {}, { sourceChecksum: "d".repeat(64) }, "source checksum"],
    ["observation checksum", {}, { checksum: "e".repeat(64) }, "observation checksum"],
  ])("%s 관측을 거부한다", async (_label, inputChange, adapterChange, error) => {
    outputChange = adapterChange;
    await expect(store.record(context, { ...input(), ...inputChange })).rejects.toThrow(error);
  });

  it("caller raw value와 다른 tenant source 사용을 거부한다", async () => {
    await expect(store.record(context, { ...input(), value: 100 } as never)).rejects.toThrow("raw value");
    await expect(store.record(otherContext, input())).rejects.toThrow();
  });

  it("기록된 MetricObservation의 값과 provenance를 direct DB로 변조할 수 없다", async () => {
    const observation = await store.record(context, input());
    await expect(
      database.query(
        "UPDATE assurance_metric_observation SET numeric_value = 100 WHERE organization_id = $organization_id AND observation_id = $observation_id;",
        { organization_id: context.organizationId, observation_id: observation.observationId },
      ),
    ).rejects.toThrow("immutable");
  });

  it("존재하지 않는 source의 forged MetricObservation direct CREATE를 거부한다", async () => {
    await expect(
      database.query(
        "CREATE assurance_metric_observation CONTENT { observation_id: $observation_id, organization_id: $organization_id, work_id: $work_id, producer_kind: 'system_adapter', producer_id: 'massion.metric.coverage.v1', source_kind: 'artifact_version', source_id: 'missing-artifact', numeric_value: 100, unit: 'percent', checksum: $checksum, source_checksum: $source_checksum, command_id: $command_id, request_hash: $request_hash, measured_at: time::now(), created_at: time::now() };",
        {
          observation_id: crypto.randomUUID(),
          organization_id: context.organizationId,
          work_id: workId,
          checksum: "a".repeat(64),
          source_checksum: "b".repeat(64),
          command_id: crypto.randomUUID(),
          request_hash: "c".repeat(64),
        },
      ),
    ).rejects.toThrow("source");
  });
});
