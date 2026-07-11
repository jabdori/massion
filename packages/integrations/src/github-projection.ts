import type { TenantContext } from "@massion/identity";

import type { IntegrationStore } from "./store.js";

function repository(value: string): { owner: string; repo: string } {
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u);
  if (!match?.[1] || !match[2] || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..")
    throw new Error("GitHub repository binding이 유효하지 않습니다");
  return { owner: match[1], repo: match[2] };
}

export class GitHubProjectionService {
  public constructor(private readonly store: IntegrationStore) {}

  public async projectPullRequest(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly installationId: string;
      readonly repository: string;
      readonly workId: string;
      readonly deliveryReceiptId: string;
      readonly title: string;
      readonly head: string;
      readonly base: string;
      readonly body: string;
    },
  ) {
    const target = repository(input.repository);
    await this.store.assertBoundResource(context, input.installationId, input.repository, "pull_request");
    return await this.store.enqueue(context, {
      commandId: input.commandId,
      installationId: input.installationId,
      destination: input.repository,
      operation: "github.pull-request",
      idempotencyKey: `work:${input.workId}:delivery:${input.deliveryReceiptId}:pr`,
      payload: {
        kind: "pull-request",
        ...target,
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
      },
    });
  }

  public async projectCheck(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly installationId: string;
      readonly repository: string;
      readonly verificationId: string;
      readonly verdict: "passed" | "failed";
      readonly headSha: string;
      readonly summary: string;
    },
  ) {
    const target = repository(input.repository);
    await this.store.assertBoundResource(context, input.installationId, input.repository, "checks");
    return await this.store.enqueue(context, {
      commandId: input.commandId,
      installationId: input.installationId,
      destination: input.repository,
      operation: "github.check-run",
      idempotencyKey: `verification:${input.verificationId}:check`,
      payload: {
        kind: "check-run",
        ...target,
        headSha: input.headSha,
        name: "Massion Assurance",
        status: "completed",
        conclusion: input.verdict === "passed" ? "success" : "failure",
        output: { title: `Assurance ${input.verdict}`, summary: input.summary },
        externalId: input.verificationId,
      },
    });
  }

  public async projectRecord(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly installationId: string;
      readonly repository: string;
      readonly recordId: string;
      readonly verificationVerdict: "passed" | "failed";
      readonly path: string;
      readonly markdown: string;
      readonly existingSha?: string;
    },
  ) {
    if (input.verificationVerdict !== "passed")
      throw new Error("passed Verification 없는 Records는 GitHub에 materialize할 수 없습니다");
    const target = repository(input.repository);
    await this.store.assertBoundResource(context, input.installationId, input.repository, "records");
    return await this.store.enqueue(context, {
      commandId: input.commandId,
      installationId: input.installationId,
      destination: input.repository,
      operation: "github.records",
      idempotencyKey: `record:${input.recordId}:materialize`,
      payload: {
        kind: "materialize",
        ...target,
        path: input.path,
        message: `docs: materialize Massion record ${input.recordId}`,
        contentBase64: Buffer.from(input.markdown).toString("base64"),
        ...(input.existingSha === undefined ? {} : { sha: input.existingSha }),
      },
    });
  }

  public async projectRelease(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly installationId: string;
      readonly repository: string;
      readonly workId: string;
      readonly workStatus: string;
      readonly approved: boolean;
      readonly tag: string;
      readonly name: string;
      readonly body: string;
    },
  ) {
    if (input.workStatus !== "completed" || !input.approved)
      throw new Error("완료되고 승인된 Work만 GitHub Release로 투영할 수 있습니다");
    const target = repository(input.repository);
    await this.store.assertBoundResource(context, input.installationId, input.repository, "release");
    return await this.store.enqueue(context, {
      commandId: input.commandId,
      installationId: input.installationId,
      destination: input.repository,
      operation: "github.release",
      idempotencyKey: `work:${input.workId}:release:${input.tag}`,
      payload: { kind: "release", ...target, tag: input.tag, name: input.name, body: input.body },
    });
  }
}
