import type { TenantContext } from "@massion/identity";
import { describe, expect, it, vi } from "vitest";

import { GitHubInboundProjector } from "./github-inbound.js";

const context: TenantContext = {
  userId: "user-12345678",
  organizationId: "organization-12345678",
  membershipId: "membership-12345678",
  role: "owner",
};

describe("GitHub inbound Evidence·Collaboration projector", () => {
  it("PR review는 외부 작성자를 가장하지 않고 Collaboration review port로 전달한다", async () => {
    const postReview = vi.fn(async () => ({ posted: true }));
    const record = vi.fn(async () => ({}));
    const projector = new GitHubInboundProjector({ evidence: { record }, collaboration: { postReview } });
    await expect(
      projector.observe(context, {
        kind: "application-event",
        operation: "github.pull_request_review.submitted",
        actorExternalId: "12345678",
        repository: { owner: "massion", repo: "project" },
        payload: { pullNumber: 7, reviewId: 99, state: "approved", body: "좋습니다" },
      }),
    ).resolves.toEqual({ posted: true });
    expect(postReview).toHaveBeenCalledWith(context, {
      repository: { owner: "massion", repo: "project" },
      pullNumber: 7,
      reviewId: 99,
      state: "approved",
      body: "좋습니다",
      actorExternalId: "12345678",
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("Check·Push·PR 변경은 immutable Evidence port에 최소 payload로 전달한다", async () => {
    const record = vi.fn(async () => ({ recorded: true }));
    const projector = new GitHubInboundProjector({
      evidence: { record },
      collaboration: { postReview: async () => ({}) },
    });
    await projector.observe(context, {
      kind: "application-event",
      operation: "github.check_suite.completed",
      actorExternalId: "12345678",
      repository: { owner: "massion", repo: "project" },
      payload: { checkSuiteId: 88, status: "completed", conclusion: "success", headSha: "a".repeat(40) },
    });
    expect(record).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ externalId: "check-suite:88", operation: "github.check_suite.completed" }),
    );
  });
});
