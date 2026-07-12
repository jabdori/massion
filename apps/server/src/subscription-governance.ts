import { createHash } from "node:crypto";

import {
  GovernanceApprovalRequiredError,
  GovernanceDeniedError,
  normalizeApprovalDisplayPreview,
  type ApprovalStore,
  type ApprovalDisplayPreview,
  type GovernanceGate,
  type GovernedActionInput,
} from "@massion/governance";
import type { TenantContext } from "@massion/identity";
import type { SubscriptionPermissionBridge } from "@massion/runtime";

import type { SubscriptionAgentExecutionPolicy, SubscriptionAgentPolicyPort } from "./subscription-runtime-resolver.js";

interface ApprovalRequirementView {
  readonly actions: readonly string[];
  readonly environments: readonly string[];
  readonly riskClasses: readonly string[];
}

interface ActivePolicyReader {
  getActivePolicy(context: TenantContext): Promise<
    | {
        readonly requirements: readonly ApprovalRequirementView[];
      }
    | undefined
  >;
}

interface SubscriptionApprovalModeReader {
  resolve(
    context: TenantContext,
    providerId: string,
  ): Promise<{ readonly approvalMode: "automatic" | "review" | "deny" }>;
}

function matches(values: readonly string[], value: string): boolean {
  return values.includes("*") || values.includes(value);
}

function requiresToolApproval(requirement: ApprovalRequirementView, environment: string): boolean {
  // 실행을 시작하는 시점에는 실제 도구의 위험 등급을 아직 알 수 없습니다.
  // 따라서 현재 환경에서 도구 호출 승인을 하나라도 요구하면 review로 시작합니다.
  void requirement.riskClasses;
  return matches(requirement.actions, "tool.call") && matches(requirement.environments, environment);
}

function canWriteWorkspace(agentHandle: string): boolean {
  return agentHandle === "software-development" || agentHandle.startsWith("software-engineering");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("도구 입력 JSON 깊이 상한을 초과했습니다");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((child) => canonicalJson(child, depth + 1)).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child, depth + 1)}`)
      .join(",")}}`;
  }
  throw new Error("도구 입력은 JSON-safe 값이어야 합니다");
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024 || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return normalized;
}

function externalTool(toolName: string): boolean {
  return /(?:web|http|fetch|search|network|browser)/iu.test(toolName);
}

function optionalInputText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function shellPreviewTokens(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command.slice(0, 16_384)) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) tokens.push(current);
      current = "";
      if (tokens.length >= 64) break;
      continue;
    }
    current += character;
  }
  if (current && tokens.length < 64) tokens.push(current);
  return tokens;
}

function commandPreviewTokens(value: unknown): readonly string[] {
  if (typeof value === "string") return shellPreviewTokens(value);
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).map((item) => {
    if (typeof item !== "string") throw new Error("승인 명령 미리보기 인수가 유효하지 않습니다");
    return item;
  });
}

function fileChangeTool(toolName: string): boolean {
  return /(?:write|edit|file|patch|notebook)/iu.test(toolName);
}

function commandTool(toolName: string, toolInput: Readonly<Record<string, unknown>>): boolean {
  return toolInput.command !== undefined || /(?:bash|shell|command|execute|terminal)/iu.test(toolName);
}

function approvalDisplayPreview(input: {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly title?: string;
  readonly decisionReason?: string;
}): ApprovalDisplayPreview {
  const toolReason = optionalInputText(input.toolInput.reason);
  if (commandTool(input.toolName, input.toolInput)) {
    const tokens = commandPreviewTokens(input.toolInput.command);
    return normalizeApprovalDisplayPreview({
      kind: "command",
      title: input.title ?? `명령 실행 (${input.toolName})`,
      executable: tokens[0] ?? input.toolName,
      arguments: tokens.slice(1),
      ...(optionalInputText(input.toolInput.cwd) ? { cwd: input.toolInput.cwd } : {}),
      ...((input.decisionReason ?? toolReason) ? { reason: input.decisionReason ?? toolReason } : {}),
    });
  }
  if (fileChangeTool(input.toolName)) {
    const path =
      optionalInputText(input.toolInput.file_path) ??
      optionalInputText(input.toolInput.path) ??
      optionalInputText(input.toolInput.grantRoot) ??
      "제공자 미제공";
    return normalizeApprovalDisplayPreview({
      kind: "file-change",
      title: input.title ?? `파일 변경 (${input.toolName})`,
      path,
      summary: toolReason ?? input.title ?? `${input.toolName} 변경 요청`,
      ...(input.decisionReason ? { reason: input.decisionReason } : {}),
    });
  }
  return normalizeApprovalDisplayPreview({
    kind: "provider",
    title: input.title ?? `${input.toolName} 요청`,
    ...((input.decisionReason ?? toolReason) ? { reason: input.decisionReason ?? toolReason } : {}),
  });
}

export class SubscriptionAgentPolicyResolver implements SubscriptionAgentPolicyPort {
  public constructor(
    private readonly policies: ActivePolicyReader,
    private readonly environment: "local" | "team",
    private readonly subscriptionPolicies?: SubscriptionApprovalModeReader,
  ) {}

  public async resolve(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly agentHandle: string;
      readonly providerId: string;
      readonly accountId: string;
      readonly connectorId: string;
      readonly workspaceRoot: string;
    },
  ): Promise<SubscriptionAgentExecutionPolicy> {
    void input.executionId;
    void input.workId;
    void input.accountId;
    void input.connectorId;
    void input.workspaceRoot;
    const [active, subscription] = await Promise.all([
      this.policies.getActivePolicy(context),
      this.subscriptionPolicies?.resolve(context, input.providerId),
    ]);
    const approvalMode = subscription?.approvalMode ?? "review";
    const governanceCanReview =
      !active || active.requirements.some((requirement) => requiresToolApproval(requirement, this.environment));
    if (approvalMode === "review" && !governanceCanReview) {
      throw new Error("구독 검토 방식에는 활성 Governance tool.call 승인 요구사항이 필요합니다");
    }
    return {
      sandboxMode: canWriteWorkspace(input.agentHandle) ? "workspace-write" : "read-only",
      approvalPolicy: approvalMode === "automatic" ? "never" : approvalMode === "review" ? "on-request" : "deny",
      networkAccessEnabled: false,
    };
  }
}

export class GovernanceSubscriptionPermissionBridge implements SubscriptionPermissionBridge {
  private readonly pending = new Map<
    string,
    {
      readonly approvalId: string;
      readonly executionId: string;
      readonly requesterContext: TenantContext;
      readonly request: GovernedActionInput;
    }
  >();

  public constructor(
    private readonly governance: Pick<GovernanceGate, "authorize"> & Partial<Pick<GovernanceGate, "getApprovalStatus">>,
    private readonly environment: "local" | "team",
    private readonly approvals?: Pick<ApprovalStore, "cancel">,
  ) {}

  public async request(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly agentHandle: string;
      readonly toolName: string;
      readonly toolInput: Readonly<Record<string, unknown>>;
      readonly toolUseId: string;
      readonly permissionRequestId: string;
      readonly title?: string;
      readonly decisionReason?: string;
    },
  ): Promise<
    | { readonly outcome: "allow" }
    | { readonly outcome: "deny"; readonly reason: string }
    | { readonly outcome: "suspend"; readonly approvalId: string }
  > {
    const toolName = requireIdentifier(input.toolName, "도구 이름");
    const inputDigest = digest(canonicalJson(input.toolInput));
    const callIdentity = digest(
      `${requireIdentifier(input.toolUseId, "도구 호출 ID")}\0${requireIdentifier(input.permissionRequestId, "권한 요청 ID")}\0${toolName}\0${inputDigest}`,
    );
    const external = externalTool(toolName);
    const governedRequest: GovernedActionInput = {
      commandId: `${input.executionId}:tool:${callIdentity}`,
      action: "tool.call",
      resource: {
        type: "Tool",
        id: `tool-call:${callIdentity}`,
        attributes: {
          toolName,
          toolInputDigest: inputDigest,
          agentHandle: input.agentHandle,
          workId: input.workId,
        },
      },
      environment: this.environment,
      riskClass: external ? "external-tool" : "agent-tool",
      external,
      executionId: input.executionId,
      workId: input.workId,
      resumeTarget: "runtime-subscription",
      approvalPreview: approvalDisplayPreview({
        toolName,
        toolInput: input.toolInput,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.decisionReason === undefined ? {} : { decisionReason: input.decisionReason }),
      }),
    };
    try {
      await this.governance.authorize(context, governedRequest);
      return { outcome: "allow" };
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) {
        this.pending.set(this.pendingKey(input.executionId, error.approvalId), {
          approvalId: error.approvalId,
          executionId: input.executionId,
          requesterContext: context,
          request: governedRequest,
        });
        return { outcome: "suspend", approvalId: error.approvalId };
      }
      if (error instanceof GovernanceDeniedError) {
        return { outcome: "deny", reason: "Governance 정책이 도구 실행을 거부했습니다" };
      }
      return { outcome: "deny", reason: "Governance 도구 승인 상태를 확인할 수 없습니다" };
    }
  }

  public async consume(
    context: TenantContext,
    input: { readonly executionId: string; readonly approvalId: string },
  ): Promise<"approved" | "rejected"> {
    const executionId = requireIdentifier(input.executionId, "실행 ID");
    const approvalId = requireIdentifier(input.approvalId, "승인 ID");
    const pending = this.pending.get(this.pendingKey(executionId, approvalId));
    if (!pending) {
      const executionPending = [...this.pending.values()].some((candidate) => candidate.executionId === executionId);
      throw new Error(
        executionPending ? "구독 Agent 실행 승인 ID가 일치하지 않습니다" : "재개할 구독 Agent 승인이 없습니다",
      );
    }
    if (!this.governance.getApprovalStatus) throw new Error("구독 승인 상태 reader가 구성되지 않았습니다");
    const status = await this.governance.getApprovalStatus(context, approvalId);
    if (status === "rejected") {
      this.pending.delete(this.pendingKey(executionId, approvalId));
      return "rejected";
    }
    if (status !== "approved") throw new Error(`결정되지 않은 구독 Agent 승인입니다: ${status}`);
    await this.governance.authorize(pending.requesterContext, {
      ...pending.request,
      commandId: `${pending.request.commandId}:resume`,
      approvalId,
    });
    this.pending.delete(this.pendingKey(executionId, approvalId));
    return "approved";
  }

  public async interrupt(
    context: TenantContext,
    input: { readonly executionId: string; readonly approvalId: string },
  ): Promise<void> {
    const executionId = requireIdentifier(input.executionId, "실행 ID");
    const approvalId = requireIdentifier(input.approvalId, "승인 ID");
    if (!this.approvals) throw new Error("구독 승인 취소 정본이 구성되지 않았습니다");
    if (!this.governance.getApprovalStatus) throw new Error("구독 승인 상태 reader가 구성되지 않았습니다");
    const status = await this.governance.getApprovalStatus(context, approvalId);
    if (status === "pending" || status === "approved") {
      await this.approvals.cancel(context, {
        commandId: `${executionId}:approval:${digest(approvalId)}:runtime-interrupted`,
        approvalId,
        reason: "Provider live process를 재구성할 수 없어 실행이 중단됐습니다",
      });
    }
    this.pending.delete(this.pendingKey(executionId, approvalId));
  }

  private pendingKey(executionId: string, approvalId: string): string {
    return `${executionId}\0${approvalId}`;
  }
}
