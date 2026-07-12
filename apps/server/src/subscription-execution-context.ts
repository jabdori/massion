import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { TenantContext } from "@massion/identity";
import type { RoutedExecutionContextResolver } from "@massion/runtime";

import type {
  SubscriptionWorkspaceCapabilityVerifier,
  WorkspaceCapabilityView,
} from "./subscription-runtime-resolver.js";

interface SubscriptionWorkAccessReader {
  getWork(
    context: TenantContext,
    workId: string,
  ): Promise<{ readonly work_id: string; readonly organization_id: string }>;
}

function segment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function ownerOnlyDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("구독 Agent 작업공간이 안전하지 않습니다");
  await chmod(path, 0o700);
  return await realpath(path);
}

export class MassionSubscriptionExecutionContext
  implements RoutedExecutionContextResolver, SubscriptionWorkspaceCapabilityVerifier
{
  public constructor(
    private readonly workspaceRoot: string,
    private readonly works: SubscriptionWorkAccessReader,
  ) {
    if (!isAbsolute(workspaceRoot)) throw new Error("구독 Agent 작업공간 root는 절대 경로여야 합니다");
  }

  public async resolve(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly taskId?: string;
      readonly agentHandle: string;
    },
  ): Promise<{ readonly workspaceRoot: string }> {
    void input.executionId;
    void input.taskId;
    void input.agentHandle;
    await this.requireWorkAccess(context, input.workId);
    const root = await ownerOnlyDirectory(resolve(this.workspaceRoot));
    const organizationRoot = await ownerOnlyDirectory(resolve(root, segment(context.organizationId)));
    const workRoot = await ownerOnlyDirectory(resolve(organizationRoot, segment(input.workId)));
    if (!within(root, organizationRoot) || !within(organizationRoot, workRoot)) {
      throw new Error("구독 Agent 작업공간이 관리 root 밖입니다");
    }
    return { workspaceRoot: workRoot };
  }

  public async verify(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly agentHandle: string;
      readonly providerId: string;
      readonly accountId: string;
      readonly connectorId: string;
      readonly requestedWorkspaceRoot: string;
    },
  ): Promise<WorkspaceCapabilityView> {
    void input.executionId;
    void input.agentHandle;
    void input.providerId;
    void input.accountId;
    void input.connectorId;
    await this.requireWorkAccess(context, input.workId);
    if (!isAbsolute(input.requestedWorkspaceRoot)) throw new Error("발급된 작업공간과 요청 경로가 일치하지 않습니다");
    try {
      const root = await ownerOnlyDirectory(resolve(this.workspaceRoot));
      const organizationRoot = resolve(root, segment(context.organizationId));
      const expected = resolve(organizationRoot, segment(input.workId));
      const requestedMetadata = await lstat(input.requestedWorkspaceRoot);
      if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
        throw new Error("not-owner-directory");
      }
      const [actualOrganization, actualExpected, actualRequested] = await Promise.all([
        realpath(organizationRoot),
        realpath(expected),
        realpath(input.requestedWorkspaceRoot),
      ]);
      if (
        !within(root, actualOrganization) ||
        !within(actualOrganization, actualExpected) ||
        actualExpected !== actualRequested
      ) {
        throw new Error("mismatch");
      }
      return { workspaceRoot: actualRequested, allowedTools: [], disallowedTools: [] };
    } catch (error) {
      throw new Error("발급된 작업공간과 요청 경로가 일치하지 않습니다", { cause: error });
    }
  }

  private async requireWorkAccess(context: TenantContext, workId: string): Promise<void> {
    const work = await this.works.getWork(context, workId);
    if (work.work_id !== workId || work.organization_id !== context.organizationId) {
      throw new Error("현재 조직 actor가 실행할 수 있는 Work가 아닙니다");
    }
  }
}
