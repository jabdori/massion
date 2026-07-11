import type { TenantContext } from "@massion/identity";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이 유효하지 않습니다`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 65_536): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label}이 유효하지 않습니다`);
  return value;
}

export class GitHubInboundProjector {
  public constructor(
    private readonly dependencies: {
      readonly evidence: {
        record(
          context: TenantContext,
          input: {
            readonly operation: string;
            readonly repository: { readonly owner: string; readonly repo: string };
            readonly externalId: string;
            readonly payload: unknown;
          },
        ): Promise<unknown>;
      };
      readonly collaboration: {
        postReview(
          context: TenantContext,
          input: {
            readonly repository: { readonly owner: string; readonly repo: string };
            readonly pullNumber: number;
            readonly reviewId: number;
            readonly state: string;
            readonly body: string;
            readonly actorExternalId: string;
          },
        ): Promise<unknown>;
      };
    },
  ) {}

  public async observe(context: TenantContext, input: unknown): Promise<unknown> {
    const action = object(input, "GitHub normalized event");
    const operation = text(action.operation, "GitHub event operation", 128);
    const repository = object(action.repository, "GitHub event repository");
    const target = {
      owner: text(repository.owner, "GitHub owner", 100),
      repo: text(repository.repo, "GitHub repo", 100),
    };
    const payload = object(action.payload, "GitHub event payload");
    if (operation.startsWith("github.pull_request_review.")) {
      const pullNumber = Number(payload.pullNumber);
      const reviewId = Number(payload.reviewId);
      if (!Number.isSafeInteger(pullNumber) || pullNumber < 1 || !Number.isSafeInteger(reviewId) || reviewId < 1)
        throw new Error("GitHub review ID가 유효하지 않습니다");
      return await this.dependencies.collaboration.postReview(context, {
        repository: target,
        pullNumber,
        reviewId,
        state: text(payload.state, "GitHub review state", 32),
        body: typeof payload.body === "string" ? payload.body : "",
        actorExternalId: text(action.actorExternalId, "GitHub review actor", 128),
      });
    }
    const externalId =
      typeof payload.checkSuiteId === "number"
        ? `check-suite:${String(payload.checkSuiteId)}`
        : typeof payload.number === "number"
          ? `pull-request:${String(payload.number)}`
          : typeof payload.after === "string"
            ? `push:${payload.after}`
            : operation;
    return await this.dependencies.evidence.record(context, { operation, repository: target, externalId, payload });
  }
}
