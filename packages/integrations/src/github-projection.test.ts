import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitHubProjectionService } from "./github-projection.js";
import { IntegrationStore } from "./store.js";

describe("GitHub product projection", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let installationId: string;
  let service: GitHubProjectionService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "github-projection@example.com",
      displayName: "Owner",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await IntegrationStore.create(database, organizations);
    installationId = (
      await store.connect(context, {
        commandId: "connect-github-projection",
        platform: "github",
        externalTenantId: "98765432",
        credentialRef: "credential:github:projection",
        scopes: ["metadata:read", "checks:write", "contents:write", "pull_requests:write"],
      })
    ).installationId;
    await store.bindChannel(context, {
      commandId: "bind-github-projection",
      installationId,
      externalResourceId: "massion/project",
      resourceKind: "repository",
      events: ["pull_request", "checks", "records", "release"],
    });
    service = new GitHubProjectionService(store);
  });

  afterEach(async () => database.close());

  it("Delivery receipt→PR과 Verification→Check를 외부 멱등 키로 enqueue한다", async () => {
    await expect(
      service.projectPullRequest(context, {
        commandId: "project-pr-0001",
        installationId,
        repository: "massion/project",
        workId: "work-12345678",
        deliveryReceiptId: "delivery-12345678",
        title: "feat: verified change",
        head: "feature",
        base: "main",
        body: "검증 완료",
      }),
    ).resolves.toMatchObject({ operation: "github.pull-request" });
    await expect(
      service.projectCheck(context, {
        commandId: "project-check-0001",
        installationId,
        repository: "massion/project",
        verificationId: "verification-12345678",
        verdict: "passed",
        headSha: "a".repeat(40),
        summary: "모든 기준 통과",
      }),
    ).resolves.toMatchObject({ operation: "github.check-run" });
  });

  it("passed Verification 없는 Records와 미승인·미완료 Release를 차단한다", async () => {
    await expect(
      service.projectRecord(context, {
        commandId: "project-record-denied",
        installationId,
        repository: "massion/project",
        recordId: "record-12345678",
        verificationVerdict: "failed",
        path: "docs/record.md",
        markdown: "# Record",
      }),
    ).rejects.toThrow("passed Verification");
    await expect(
      service.projectRelease(context, {
        commandId: "project-release-denied",
        installationId,
        repository: "massion/project",
        workId: "work-12345678",
        workStatus: "completed",
        approved: false,
        tag: "v1.0.0",
        name: "1.0.0",
        body: "Release",
      }),
    ).rejects.toThrow("승인");
  });

  it("passed Records와 승인된 completed Work만 materialize·Release enqueue한다", async () => {
    await expect(
      service.projectRecord(context, {
        commandId: "project-record-0001",
        installationId,
        repository: "massion/project",
        recordId: "record-12345678",
        verificationVerdict: "passed",
        path: "docs/record.md",
        markdown: "# Record",
      }),
    ).resolves.toMatchObject({ operation: "github.records" });
    await expect(
      service.projectRelease(context, {
        commandId: "project-release-0001",
        installationId,
        repository: "massion/project",
        workId: "work-12345678",
        workStatus: "completed",
        approved: true,
        tag: "v1.0.0",
        name: "1.0.0",
        body: "Release",
      }),
    ).resolves.toMatchObject({ operation: "github.release" });
  });
});
