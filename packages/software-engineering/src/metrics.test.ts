import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { EngineeringMetricStore } from "./index.js";

describe("Software Engineering low-cardinality metrics", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let metrics: EngineeringMetricStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "metrics@example.com", displayName: "Metrics" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    metrics = await EngineeringMetricStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("duration·status·red·timeout·change kind·recovery를 enum dimension으로 집계한다", async () => {
    await metrics.record(context, {
      name: "engineering_delivery_duration_ms",
      value: 120,
      dimensions: { status: "committed" },
    });
    await metrics.record(context, {
      name: "engineering_delivery_duration_ms",
      value: 80,
      dimensions: { status: "committed" },
    });
    await metrics.record(context, {
      name: "engineering_red_failure_total",
      value: 1,
      dimensions: { category: "false_red" },
    });
    await metrics.record(context, {
      name: "engineering_delivery_status_total",
      value: 1,
      dimensions: { status: "committed" },
    });
    await metrics.record(context, {
      name: "engineering_command_timeout_total",
      value: 1,
      dimensions: { stage: "validation" },
    });
    await metrics.record(context, {
      name: "engineering_file_change_total",
      value: 2,
      dimensions: { kind: "modified", test: "false" },
    });
    await metrics.record(context, {
      name: "engineering_recovery_total",
      value: 1,
      dimensions: { result: "reconciled_commit" },
    });

    expect(await metrics.aggregate(context)).toEqual([
      {
        name: "engineering_command_timeout_total",
        dimensions: { stage: "validation" },
        value: 1,
      },
      {
        name: "engineering_delivery_duration_ms",
        dimensions: { status: "committed" },
        value: 200,
      },
      {
        name: "engineering_delivery_status_total",
        dimensions: { status: "committed" },
        value: 1,
      },
      {
        name: "engineering_file_change_total",
        dimensions: { kind: "modified", test: "false" },
        value: 2,
      },
      {
        name: "engineering_recovery_total",
        dimensions: { result: "reconciled_commit" },
        value: 1,
      },
      {
        name: "engineering_red_failure_total",
        dimensions: { category: "false_red" },
        value: 1,
      },
    ]);
    const [records] = await database.query<[{ dimensions_json: string }[]]>(
      "SELECT dimensions_json FROM engineering_metric_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    expect(JSON.stringify(records)).not.toMatch(/organization|repository|workId|taskId|path|commandId|agent|model/u);
  });

  it("organization·repository·work·task·path·command·agent 같은 identifier dimension을 거부한다", async () => {
    for (const key of ["organizationId", "repositoryId", "workId", "taskId", "path", "commandId", "agentHandle"]) {
      await expect(
        metrics.record(context, {
          name: "engineering_recovery_total",
          value: 1,
          dimensions: { result: "resumed", [key]: "identifier" },
        }),
      ).rejects.toThrow("low-cardinality");
    }
  });

  it("같은 idempotency key의 동일 metric은 한 번만 기록하고 payload 충돌은 거부한다", async () => {
    const input = {
      name: "engineering_recovery_total",
      value: 1,
      dimensions: { result: "resumed" },
    } as const;
    await metrics.recordOnce(context, "recovery:one", input);
    await metrics.recordOnce(context, "recovery:one", input);

    expect(await metrics.aggregate(context)).toEqual([
      {
        name: "engineering_recovery_total",
        dimensions: { result: "resumed" },
        value: 1,
      },
    ]);
    await expect(
      metrics.recordOnce(context, "recovery:one", {
        ...input,
        dimensions: { result: "cleaned_terminal" },
      }),
    ).rejects.toThrow("다른 Engineering metric");
  });
});
