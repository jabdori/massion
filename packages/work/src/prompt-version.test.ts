import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  WorkService,
  type PromptVersionResolver,
  type ResolveWorkPromptInput,
  type ResolvedWorkPrompt,
} from "./index.js";
import { WORK_PROMPT_VERSION_MIGRATION } from "./schema.js";

class RecordingPromptResolver implements PromptVersionResolver {
  public readonly resolved: ResolveWorkPromptInput[] = [];
  public readonly verified: string[] = [];

  public async resolve(_context: TenantContext, input: ResolveWorkPromptInput): Promise<ResolvedWorkPrompt> {
    this.resolved.push(input);
    return {
      promptVersionId: `prompt:${input.workId}`,
      schemaVersion: "massion.work.prompt.v1",
    };
  }

  public async verify(_context: TenantContext, promptVersionId: string): Promise<void> {
    this.verified.push(promptVersionId);
  }
}

describe("Work PromptVersion consumer port", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let resolver: RecordingPromptResolver;
  let work: WorkService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "work-prompt@example.com", displayName: "Prompt" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    resolver = new RecordingPromptResolver();
    work = await WorkService.create(database, organizations, undefined, undefined, resolver);
  });

  afterEach(async () => database.close());

  it("0053 Work Prompt 계보 migration checksum을 고정한다", () => {
    expect(WORK_PROMPT_VERSION_MIGRATION.id).toBe("0053-work-prompt-version");
    expect(WORK_PROMPT_VERSION_MIGRATION.checksum).toBe(
      "0e52c5bb24daf5e41c5fc1ad1786308d4a4eeb46593f2f40d7b891d0b3b274f1",
    );
  });

  it("새 최상위 Work에 resolver가 만든 PromptVersion을 고정한다", async () => {
    const created = await work.createWork(context, {
      commandId: "prompt-work-1",
      text: "프롬프트 계보를 고정해주세요",
      surface: "test",
      organizationVersionId: "organization-version-1",
      contextVersionId: "context-version-1",
      policyVersionId: "policy-version-1",
    });

    expect(created.work.prompt_version_id).toBe(`prompt:${created.work.work_id}`);
    expect(created.work.prompt_schema_version).toBe("massion.work.prompt.v1");
    expect(resolver.resolved).toEqual([
      {
        workId: created.work.work_id,
        requesterUserId: context.userId,
        organizationVersionId: "organization-version-1",
        contextVersionId: "context-version-1",
        policyVersionId: "policy-version-1",
      },
    ]);
    expect(resolver.verified).toEqual([created.work.prompt_version_id]);
  });

  it("caller가 Growth-aware Work의 PromptVersion ID를 직접 주입하지 못한다", async () => {
    await expect(
      work.createWork(context, {
        commandId: "forged-prompt",
        text: "임의 프롬프트",
        surface: "test",
        organizationVersionId: "organization-version-1",
        promptVersionId: "caller-controlled",
      }),
    ).rejects.toThrow("caller");
  });

  it("후속 Work는 부모의 정확한 PromptVersion을 상속한다", async () => {
    const parent = await work.createWork(context, {
      commandId: "prompt-parent",
      text: "부모 작업",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });
    const followUp = await work.createFollowUpWork(context, {
      commandId: "prompt-follow-up",
      parentWorkId: parent.work.work_id,
      text: "후속 작업",
      surface: "test",
    });

    expect(followUp.work.prompt_version_id).toBe(parent.work.prompt_version_id);
    expect(followUp.work.prompt_schema_version).toBe(parent.work.prompt_schema_version);
    expect(resolver.resolved).toHaveLength(1);
  });
});
