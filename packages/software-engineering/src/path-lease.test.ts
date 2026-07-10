import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EngineeringDeliveryStore,
  EngineeringPathLeaseStore,
  normalizeEngineeringPaths,
  pathsOverlap,
  type DeliveryPrerequisiteReader,
} from "./index.js";

describe("Engineering path 정규화와 overlap", () => {
  it("상위 prefix로 축약하고 directory segment 경계에서만 겹친다", () => {
    expect(normalizeEngineeringPaths(["src/api/", "src/api/routes", "docs/readme.md"])).toEqual([
      "docs/readme.md",
      "src/api",
    ]);
    expect(pathsOverlap(["src/api"], ["src/api/routes.ts"])).toBe(true);
    expect(pathsOverlap(["src/api"], ["src/apis.ts"])).toBe(false);
    expect(pathsOverlap(["."], ["anything/file.ts"])).toBe(true);
    expect(pathsOverlap(["src/backend"], ["src/frontend"])).toBe(false);
  });

  it.each(["", "/etc/passwd", "../secret", "src/../secret", "src\\windows", ".git/config", "src//api"])(
    "위험하거나 모호한 path를 거부한다: %s",
    (path) => {
      expect(() => normalizeEngineeringPaths([path])).toThrow("허용 경로");
    },
  );
});

describe("Engineering path lease", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let deliveryStore: EngineeringDeliveryStore;
  let leaseStore: EngineeringPathLeaseStore;
  let now: Date;

  const repositoryId = "repository-1";
  const repositoryRevisionId = "revision-1";
  const baseRevision = "0123456789abcdef0123456789abcdef01234567";

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "lease@example.com", displayName: "Lease" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const prerequisites: DeliveryPrerequisiteReader = {
      getWork: async (_context, workId) => ({ organizationId: context.organizationId, workId, status: "ready" }),
      getTask: async (_context, workId, taskId) => ({
        organizationId: context.organizationId,
        workId,
        taskId,
        status: "ready",
      }),
      getAssignment: async (_context, workId, assignmentId) => ({
        organizationId: context.organizationId,
        workId,
        taskId: assignmentId.replace("assignment", "task"),
        assignmentId,
        agentHandle: "software-engineering.backend-specialist",
        status: "assigned",
      }),
      getRepository: async () => ({ organizationId: context.organizationId, repositoryId, status: "active" }),
      getRepositoryRevision: async () => ({
        organizationId: context.organizationId,
        repositoryId,
        repositoryRevisionId,
        providerRevision: baseRevision,
        dirty: false,
      }),
    };
    deliveryStore = await EngineeringDeliveryStore.create(database, organizations, prerequisites);
    now = new Date("2026-07-10T00:00:00.000Z");
    leaseStore = await EngineeringPathLeaseStore.create(database, organizations, { now: () => now });
  });

  afterEach(async () => database.close());

  async function delivery(suffix: string) {
    return (
      await deliveryStore.start(context, {
        commandId: `delivery-${suffix}`,
        workId: `work-${suffix}`,
        taskId: `task-${suffix}`,
        assignmentId: `assignment-${suffix}`,
        repositoryId,
        repositoryRevisionId,
        baseRevision,
        agentHandle: "software-engineering.backend-specialist",
        profileVersion: "1.0.0",
      })
    ).delivery;
  }

  it("겹치는 lease 경쟁은 한 건만 성공하고 disjoint path는 병렬 허용한다", async () => {
    const first = await delivery("first");
    const second = await delivery("second");
    const [left, right] = await Promise.allSettled([
      leaseStore.acquire(context, {
        commandId: "lease-first",
        deliveryId: first.deliveryId,
        repositoryId,
        pathPrefixes: ["src/api"],
        ttlMs: 60_000,
      }),
      leaseStore.acquire(context, {
        commandId: "lease-second",
        deliveryId: second.deliveryId,
        repositoryId,
        pathPrefixes: ["src/api/routes"],
        ttlMs: 60_000,
      }),
    ]);
    expect([left, right].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([left, right].filter((result) => result.status === "rejected")).toHaveLength(1);

    const third = await delivery("third");
    await expect(
      leaseStore.acquire(context, {
        commandId: "lease-third",
        deliveryId: third.deliveryId,
        repositoryId,
        pathPrefixes: ["src/ui"],
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ lease: { status: "active", pathPrefixes: ["src/ui"] } });

    const fourth = await delivery("fourth");
    const fifth = await delivery("fifth");
    const disjoint = await Promise.all([
      leaseStore.acquire(context, {
        commandId: "lease-fourth",
        deliveryId: fourth.deliveryId,
        repositoryId,
        pathPrefixes: ["docs"],
        ttlMs: 60_000,
      }),
      leaseStore.acquire(context, {
        commandId: "lease-fifth",
        deliveryId: fifth.deliveryId,
        repositoryId,
        pathPrefixes: ["infrastructure"],
        ttlMs: 60_000,
      }),
    ]);
    expect(disjoint.every((result) => result.lease.status === "active")).toBe(true);
  });

  it("같은 acquire 명령은 멱등 재생하고 payload 변경을 거부한다", async () => {
    const target = await delivery("idempotent");
    const input = {
      commandId: "lease-idempotent",
      deliveryId: target.deliveryId,
      repositoryId,
      pathPrefixes: ["packages/api"],
      ttlMs: 60_000,
    } as const;
    const first = await leaseStore.acquire(context, input);
    const repeated = await leaseStore.acquire(context, input);
    expect(repeated.lease.leaseId).toBe(first.lease.leaseId);
    await expect(leaseStore.acquire(context, { ...input, pathPrefixes: ["packages/other"] })).rejects.toThrow(
      "다른 path lease 명령",
    );
  });

  it("만료 lease를 expired로 고정하고 같은 path를 인계한다", async () => {
    const first = await delivery("expired");
    await leaseStore.acquire(context, {
      commandId: "lease-expired",
      deliveryId: first.deliveryId,
      repositoryId,
      pathPrefixes: ["packages/shared"],
      ttlMs: 1_000,
    });
    now = new Date(now.getTime() + 1_001);
    const successor = await delivery("successor");
    await expect(
      leaseStore.acquire(context, {
        commandId: "lease-successor",
        deliveryId: successor.deliveryId,
        repositoryId,
        pathPrefixes: ["packages/shared/file.ts"],
        ttlMs: 1_000,
      }),
    ).resolves.toMatchObject({ lease: { deliveryId: successor.deliveryId, status: "active" } });
    expect((await leaseStore.list(context, repositoryId)).map((lease) => lease.status).sort()).toEqual([
      "active",
      "expired",
    ]);
  });
});
