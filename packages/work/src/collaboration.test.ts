import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { WorkService, type CollaborationMessageType, type CreateWorkResult } from "./work.js";

const MESSAGE_TYPES: readonly CollaborationMessageType[] = [
  "question",
  "answer",
  "proposal",
  "challenge",
  "review_request",
  "change_request",
  "evidence",
  "decision",
  "handoff",
  "status",
];

describe("Collaboration Room과 resource lease", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;
  let created: CreateWorkResult;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    service = await WorkService.create(database, organizations, graph);
    created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "협업",
      surface: "test",
      organizationVersionId: "org-v1",
    });
  });

  afterEach(async () => database.close());

  async function openRoom(maxRounds = 30, maxTokens = 10_000, deadline?: string) {
    return await service.openRoom(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: (await service.getWork(context, created.work.work_id)).revision,
      title: "Delivery Room",
      coordinatorHandle: "representative",
      participants: [
        { kind: "user", subjectId: context.userId, role: "participant" },
        { kind: "agent", subjectId: "representative", role: "coordinator" },
        { kind: "agent", subjectId: "assurance", role: "participant" },
      ],
      limits: { maxParallel: 2, maxTokens, maxCostMicros: 1_000_000, maxRounds, ...(deadline ? { deadline } : {}) },
    });
  }

  it("모든 구조화 message type과 reply·causation을 순서대로 기록한다", async () => {
    const opened = await openRoom();
    let previousMessageId: string | undefined;
    for (const messageType of MESSAGE_TYPES) {
      const result = await service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType,
        authorKind: messageType === "answer" ? "agent" : "user",
        authorId: messageType === "answer" ? "assurance" : context.userId,
        content: messageType,
        ...(previousMessageId ? { replyToMessageId: previousMessageId, causedByMessageId: previousMessageId } : {}),
        tokenCount: 10,
        costMicros: 100,
      });
      previousMessageId = result.message.message_id;
    }

    const messages = await service.listMessages(context, created.work.work_id, opened.room.room_id);
    expect(messages.map((message) => message.message_type)).toEqual(MESSAGE_TYPES);
    expect(messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(messages[1]?.reply_to_message_id).toBe(messages[0]?.message_id);
  });

  it("동시 message를 모두 commit하되 고유 sequence로 직렬화한다", async () => {
    const opened = await openRoom();
    const inputs = ["one", "two", "three"].map((content) =>
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "proposal",
        authorKind: "agent",
        authorId: "assurance",
        content,
        tokenCount: 1,
        costMicros: 1,
      }),
    );

    const results = await Promise.all(inputs);

    expect(results).toHaveLength(3);
    expect(
      (await service.listMessages(context, created.work.work_id, opened.room.room_id)).map(
        (message) => message.sequence,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("참여자와 round·token·deadline 한계를 강제한다", async () => {
    const opened = await openRoom(1, 2);
    await expect(
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "status",
        authorKind: "agent",
        authorId: "growth",
        content: "unauthorized",
        tokenCount: 1,
        costMicros: 0,
      }),
    ).rejects.toThrow("participant");
    await expect(
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "status",
        authorKind: "user",
        authorId: "another-user",
        content: "impersonated",
        tokenCount: 1,
        costMicros: 0,
      }),
    ).rejects.toThrow("다른 사용자");
    await service.postMessage(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      roomId: opened.room.room_id,
      messageType: "status",
      authorKind: "user",
      authorId: context.userId,
      content: "first",
      tokenCount: 2,
      costMicros: 0,
    });
    await expect(
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: opened.room.room_id,
        messageType: "status",
        authorKind: "user",
        authorId: context.userId,
        content: "second",
        tokenCount: 1,
        costMicros: 0,
      }),
    ).rejects.toThrow("round 한도");
    const expired = await openRoom(5, 100, new Date(Date.now() - 1_000).toISOString());
    await expect(
      service.postMessage(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        roomId: expired.room.room_id,
        messageType: "status",
        authorKind: "user",
        authorId: context.userId,
        content: "late",
        tokenCount: 1,
        costMicros: 0,
      }),
    ).rejects.toThrow("deadline");
  });

  it("불변 Shared Context Reference와 versioned lease를 관리한다", async () => {
    const opened = await openRoom();
    let work = await service.getWork(context, created.work.work_id);
    const checksum = createHash("sha256").update("context-v1").digest("hex");
    const shared = await service.addSharedContext(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      roomId: opened.room.room_id,
      sourceKind: "context",
      sourceId: "context-1",
      versionId: "v1",
      checksum,
    });
    work = shared.work;
    const acquired = await service.acquireLease(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      resourceKey: "artifact:file-1",
      holderId: "assurance",
      ttlMs: 60_000,
    });

    await expect(
      service.acquireLease(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: acquired.work.revision,
        resourceKey: "artifact:file-1",
        holderId: "representative",
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("이미 활성");
    const renewed = await service.renewLease(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: acquired.work.revision,
      resourceKey: "artifact:file-1",
      holderId: "assurance",
      expectedLeaseVersion: 1,
      ttlMs: 120_000,
    });
    const released = await service.releaseLease(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: renewed.work.revision,
      resourceKey: "artifact:file-1",
      holderId: "assurance",
      expectedLeaseVersion: renewed.lease.version,
    });

    expect(shared.reference).toMatchObject({ source_id: "context-1", version_id: "v1", checksum });
    expect(released.lease.status).toBe("released");
    expect(released.lease.version).toBe(3);
  });
});
