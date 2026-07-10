import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { WorkService } from "./work.js";

describe("불변 부모에서 만드는 linked follow-up Work", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "follow-up@example.com", displayName: "Follow Up" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    service = await WorkService.create(database, organizations);
  });

  afterEach(async () => database.close());

  async function cancelledParent() {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "첫 제품을 완성한다",
      surface: "test",
      organizationVersionId: "organization-version-7",
      contextVersionId: "context-version-4",
      policyVersionId: "policy-version-3",
      promptVersionId: "prompt-version-2",
    });
    const artifact = await service.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      kind: "report",
      name: "result",
      mediaType: "application/json",
      content: { completed: true },
    });
    return (
      await service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: artifact.work.revision,
        target: "cancelled",
      })
    ).work;
  }

  it("부모를 바꾸지 않고 모든 고정 버전과 Artifact 참조를 자식 draft에 상속한다", async () => {
    const parent = await cancelledParent();
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      parentWorkId: parent.work_id,
      text: "배포 환경도 추가해주세요",
      surface: "test",
    } as const;

    const first = await service.createFollowUpWork(context, input);
    const repeated = await service.createFollowUpWork(context, input);

    expect(first.work).toMatchObject({
      parent_work_id: parent.work_id,
      status: "draft",
      revision: 1,
      organization_version_id: parent.organization_version_id,
      context_version_id: parent.context_version_id,
      policy_version_id: parent.policy_version_id,
      prompt_version_id: parent.prompt_version_id,
      artifact_version_ids: parent.artifact_version_ids,
    });
    expect(first.event).toMatchObject({ sequence: 1, event_type: "follow_up_work_created" });
    expect(first.request).toMatchObject({ text: input.text, surface: input.surface });
    expect(repeated.work.work_id).toBe(first.work.work_id);
    expect(await service.getWork(context, parent.work_id)).toEqual(parent);
  });

  it("같은 command의 다른 payload와 다른 조직의 부모 접근을 거부한다", async () => {
    const parent = await cancelledParent();
    const input = {
      commandId: crypto.randomUUID(),
      parentWorkId: parent.work_id,
      text: "후속 요청",
      surface: "test",
    };
    await service.createFollowUpWork(context, input);
    await expect(service.createFollowUpWork(context, { ...input, text: "다른 후속 요청" })).rejects.toThrow(
      "다른 명령",
    );

    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const outsider = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const outsiderContext = await organizations.resolveTenantContext(
      outsider.user.user_id,
      outsider.organization.organization_id,
    );
    await expect(
      service.createFollowUpWork(outsiderContext, { ...input, commandId: crypto.randomUUID() }),
    ).rejects.toThrow("부모 Work를 찾을 수 없습니다");
  });
});
