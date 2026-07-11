const API_VERSION = "2026-03-10";
function record(value: unknown, label = "GitHub input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이 object여야 합니다`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 65536): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`${label} 문자열 상한이 유효하지 않습니다`);
  return value;
}
function name(value: unknown, label: string): string {
  const result = text(value, label, 100);
  if (!/^[A-Za-z0-9_.-]+$/u.test(result) || result === "." || result === "..")
    throw new Error(`${label}이 유효하지 않습니다`);
  return result;
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label}이 유효하지 않습니다`);
  return value as number;
}
function repository(value: unknown): { owner: string; repo: string } {
  const source = record(value, "GitHub repository");
  const fullName = text(source.full_name, "GitHub repository full_name", 201);
  const match = fullName.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u);
  if (!match) throw new Error("GitHub repository full_name이 유효하지 않습니다");
  return { owner: name(match[1], "GitHub owner"), repo: name(match[2], "GitHub repo") };
}
const headers = { accept: "application/vnd.github+json", apiVersion: API_VERSION } as const;

export async function invokeGitHub(contribution: string, input: unknown): Promise<unknown> {
  await Promise.resolve();
  const source = record(input);
  if (contribution === "surfaceConnectors:github") {
    const repo = repository(source.repository);
    const sender = record(source.sender, "GitHub sender");
    const actorExternalId = String(integer(sender.id, "GitHub sender ID"));
    const event = text(source.event, "GitHub event", 64);
    const action = text(source.action, "GitHub action", 64);
    if (event === "issues" && action === "opened") {
      const issue = record(source.issue, "GitHub issue");
      return {
        kind: "application-command",
        operation: "work.create",
        actorExternalId,
        repository: repo,
        arguments: {
          request: `${text(issue.title, "issue title", 256)}\n\n${typeof issue.body === "string" ? issue.body.slice(0, 32000) : ""}`,
          external: { kind: "github-issue", number: integer(issue.number, "issue number") },
        },
      };
    }
    if (event === "issue_comment" && action === "created") {
      const comment = record(source.comment, "GitHub comment");
      const body = text(comment.body, "comment body");
      const request = body.match(/^\/massion(?:\s+)([\s\S]{1,32000})$/u)?.[1];
      if (!request) return { kind: "ignored", reason: "not-massion-command" };
      return {
        kind: "application-command",
        operation: "work.create",
        actorExternalId,
        repository: repo,
        arguments: { request, external: { kind: "github-comment", id: integer(comment.id, "comment ID") } },
      };
    }
    if (event === "pull_request") {
      const pull = record(source.pull_request, "GitHub pull request");
      const head = record(pull.head, "GitHub pull request head");
      return {
        kind: "application-event",
        operation: `github.pull_request.${action}`,
        actorExternalId,
        repository: repo,
        payload: {
          number: integer(pull.number, "pull request number"),
          title: text(pull.title, "pull request title", 256),
          state: text(pull.state, "pull request state", 32),
          headSha: text(head.sha, "pull request head SHA", 40),
        },
      };
    }
    if (event === "pull_request_review") {
      const pull = record(source.pull_request, "GitHub pull request");
      const review = record(source.review, "GitHub review");
      return {
        kind: "application-event",
        operation: `github.pull_request_review.${action}`,
        actorExternalId,
        repository: repo,
        payload: {
          pullNumber: integer(pull.number, "pull request number"),
          reviewId: integer(review.id, "review ID"),
          state: text(review.state, "review state", 32),
          body: typeof review.body === "string" ? review.body.slice(0, 32_000) : "",
        },
      };
    }
    if (event === "check_suite") {
      const suite = record(source.check_suite, "GitHub check suite");
      return {
        kind: "application-event",
        operation: `github.check_suite.${action}`,
        actorExternalId,
        repository: repo,
        payload: {
          checkSuiteId: integer(suite.id, "check suite ID"),
          status: text(suite.status, "check suite status", 32),
          conclusion: typeof suite.conclusion === "string" ? suite.conclusion : undefined,
          headSha: text(suite.head_sha, "check suite head SHA", 40),
        },
      };
    }
    if (event === "push")
      return {
        kind: "application-event",
        operation: "github.push.received",
        actorExternalId,
        repository: repo,
        payload: {
          ref: text(source.ref, "push ref", 512),
          before: text(source.before, "push before SHA", 40),
          after: text(source.after, "push after SHA", 40),
          forced: source.forced === true,
        },
      };
    return { kind: "ignored", reason: "unsupported-event" };
  }
  if (contribution !== "eventConsumers:github-sync") throw new Error("지원하지 않는 GitHub contribution입니다");
  const owner = name(source.owner, "GitHub owner");
  const repo = name(source.repo, "GitHub repo");
  const base = `/repos/${owner}/${repo}`;
  if (source.kind === "pull-request")
    return {
      method: "POST",
      path: `${base}/pulls`,
      headers,
      body: {
        title: text(source.title, "PR title", 256),
        head: name(source.head, "PR head"),
        base: name(source.base, "PR base"),
        body: text(source.body, "PR body"),
      },
    };
  if (source.kind === "check-run") {
    const sha = text(source.headSha, "Check SHA", 40);
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Check SHA가 유효하지 않습니다");
    return {
      method: "POST",
      path: `${base}/check-runs`,
      headers,
      body: {
        name: text(source.name, "Check name", 128),
        head_sha: sha,
        status: source.status,
        conclusion: source.conclusion,
        output: source.output,
        external_id: text(source.externalId, "Check external ID", 128),
      },
    };
  }
  if (source.kind === "materialize") {
    const path = text(source.path, "Records path", 512);
    if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".."))
      throw new Error("Records path가 유효하지 않습니다");
    return {
      method: "PUT",
      path: `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
      headers,
      body: {
        message: text(source.message, "commit message", 256),
        content: text(source.contentBase64, "Records content", 262144),
        sha: source.sha,
      },
    };
  }
  if (source.kind === "release")
    return {
      method: "POST",
      path: `${base}/releases`,
      headers,
      body: {
        tag_name: name(source.tag, "Release tag"),
        name: text(source.name, "Release name", 256),
        body: text(source.body, "Release body"),
        draft: true,
      },
    };
  throw new Error("지원하지 않는 GitHub sync kind입니다");
}
