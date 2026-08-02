import { createHash } from "node:crypto";
import { isAbsolute, normalize, posix, relative } from "node:path";

// Terminal receipt의 계보·최종 출력 여유를 남기는 보수적 총량입니다.
const MAXIMUM_EVIDENCE_BYTES = 8 * 1024;
const MAXIMUM_ITEM_TEXT_BYTES = 12 * 1024;

// evidence 패키지가 runtime을 간접 의존하므로 순환 의존을 만들지 않도록, 동일한 영수증 경계 redaction만 둡니다.
function redactSecrets(content: string): string {
  return content
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/gu, "[REDACTED]")
    .replace(
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*(["'])([^"'\r\n]{8,})\1/giu,
      "$1[REDACTED]$1",
    )
    .replace(/\b([A-Za-z][A-Za-z0-9_-]*)=([^\s"']+)/gu, (value, key: string) => {
      const parts = key.toLowerCase().split(/[_-]/u);
      const secret = new Set(["token", "secret", "key", "password", "auth", "credential"]);
      return parts.some((part) => secret.has(part)) ? `${key}=[REDACTED]` : value;
    })
    .replace(
      /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}/giu,
      "Bearer [REDACTED]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{35}\b/gu, "[REDACTED]");
}

export type ExecutionEvidenceItem =
  | {
      readonly providerItemId: string;
      readonly kind: "command";
      readonly command: string;
      readonly output: string;
      readonly exitCode: 0;
      readonly status: "completed";
      readonly byteCount: number;
      readonly truncated?: true;
    }
  | {
      readonly providerItemId: string;
      readonly kind: "file";
      readonly path: string;
      readonly changeKind: "added" | "modified" | "deleted";
      readonly status: "completed";
    };

export interface ExecutionEvidence {
  readonly items: readonly ExecutionEvidenceItem[];
  /** 저장 전 redaction을 적용한 전체 provider 관측값의 SHA-256입니다. */
  readonly checksum: string;
  readonly byteCount: number;
  readonly truncated?: true;
}

export type CodexExecutionEvidenceItem =
  | {
      readonly id: unknown;
      readonly type: "command_execution" | "commandExecution";
      readonly command: unknown;
      readonly aggregated_output?: unknown;
      readonly aggregatedOutput?: unknown;
      readonly exit_code?: unknown;
      readonly exitCode?: unknown;
      readonly status: unknown;
    }
  | {
      readonly id: unknown;
      readonly type: "file_change" | "fileChange";
      readonly changes: unknown;
      readonly status: unknown;
    };

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  throw new Error("실행 근거 값이 JSON-safe하지 않습니다");
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 512 || /\0/u.test(value)) return undefined;
  return value;
}

function boundedRedactedText(
  value: unknown,
): { readonly value: string; readonly byteCount: number; readonly truncated: boolean } | undefined {
  if (typeof value !== "string" || /\0/u.test(value)) return undefined;
  if (/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(value)) return undefined;
  const redacted = redactSecrets(value);
  const byteCount = Buffer.byteLength(redacted);
  const bytes = Buffer.from(redacted);
  let end = Math.min(bytes.length, MAXIMUM_ITEM_TEXT_BYTES);
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  const bounded = bytes.subarray(0, end).toString("utf8");
  return { value: bounded, byteCount, truncated: byteCount > MAXIMUM_ITEM_TEXT_BYTES };
}

function workspaceRelativePath(value: unknown, workspaceRoot: string): string | undefined {
  if (typeof value !== "string" || !value || /\0/u.test(value) || value.includes("\\")) return undefined;
  const candidate = isAbsolute(value) ? relative(workspaceRoot, value) : value;
  if (isAbsolute(value) && (normalize(value) !== value || normalize(workspaceRoot) !== workspaceRoot)) return undefined;
  const normalized = posix.normalize(candidate);
  if (normalized !== candidate || normalized === "." || normalized.startsWith("../") || normalized === "..")
    return undefined;
  return normalized;
}

function changeKind(value: unknown): "added" | "modified" | "deleted" | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) value = (value as { type?: unknown }).type;
  if (value === "add" || value === "added") return "added";
  if (value === "update" || value === "modified") return "modified";
  if (value === "delete" || value === "deleted") return "deleted";
  return undefined;
}

function itemBytes(item: ExecutionEvidenceItem): number {
  return Buffer.byteLength(canonical(item));
}

export function executionEvidenceByteCount(items: readonly ExecutionEvidenceItem[]): number {
  return items.reduce((total, item) => total + itemBytes(item), 0);
}

export function executionEvidenceIsSafe(value: unknown): value is ExecutionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as ExecutionEvidence;
  if (!Object.keys(evidence).every((key) => ["items", "checksum", "byteCount", "truncated"].includes(key)))
    return false;
  const items: readonly unknown[] = evidence.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 256) return false;
  if (!/^[a-f0-9]{64}$/u.test(evidence.checksum) || !Number.isSafeInteger(evidence.byteCount)) return false;
  const ids = new Set<string>();
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const item = candidate as Record<string, unknown>;
    if (typeof item.providerItemId !== "string" || !item.providerItemId || ids.has(item.providerItemId)) return false;
    ids.add(item.providerItemId);
    if (item.kind === "command") {
      if (
        !Object.keys(item).every((key) =>
          ["providerItemId", "kind", "command", "output", "exitCode", "status", "byteCount", "truncated"].includes(key),
        )
      )
        return false;
      if (
        item.status !== "completed" ||
        item.exitCode !== 0 ||
        typeof item.command !== "string" ||
        typeof item.output !== "string" ||
        !boundedRedactedText(item.command) ||
        !boundedRedactedText(item.output) ||
        redactSecrets(item.command) !== item.command ||
        redactSecrets(item.output) !== item.output
      )
        return false;
      const storedBytes = Buffer.byteLength(item.command) + Buffer.byteLength(item.output);
      if (
        !Number.isSafeInteger(item.byteCount) ||
        item.byteCount < storedBytes ||
        (!item.truncated && item.byteCount !== storedBytes)
      )
        return false;
    } else if (
      item.kind !== "file" ||
      item.status !== "completed" ||
      typeof item.path !== "string" ||
      typeof item.changeKind !== "string" ||
      !workspaceRelativePath(item.path, "/workspace") ||
      !["added", "modified", "deleted"].includes(item.changeKind)
    ) {
      return false;
    } else if (
      !Object.keys(item).every((key) => ["providerItemId", "kind", "path", "changeKind", "status"].includes(key))
    ) {
      return false;
    }
  }
  const normalizedItems = items as readonly ExecutionEvidenceItem[];
  return (
    evidence.byteCount === executionEvidenceByteCount(normalizedItems) &&
    evidence.byteCount <= MAXIMUM_EVIDENCE_BYTES &&
    evidence.checksum === executionEvidenceChecksum(normalizedItems)
  );
}

export function executionEvidenceChecksum(items: readonly ExecutionEvidenceItem[]): string {
  return createHash("sha256").update(canonical(items)).digest("hex");
}

/** Codex의 terminal tool item만, 저장 가능한 최소 영수증으로 정규화합니다. */
export function normalizeCodexExecutionEvidence(
  items: readonly unknown[],
  workspaceRoot: string,
): ExecutionEvidence | undefined {
  if (!isAbsolute(workspaceRoot) || normalize(workspaceRoot) !== workspaceRoot) {
    throw new Error("실행 근거 workspace root가 유효하지 않습니다");
  }
  const observed: ExecutionEvidenceItem[] = [];
  const ids = new Map<string, string>();
  const rawItemIds = new Map<string, string>();
  let byteCount = 0;
  let truncated = false;

  for (const value of items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as CodexExecutionEvidenceItem;
    const id = identifier(item.id);
    if (!id) continue;
    if ((item.type === "command_execution" || item.type === "commandExecution") && item.status === "completed") {
      const source = createHash("sha256").update(canonical(item)).digest("hex");
      const previousSource = ids.get(id);
      if (previousSource !== undefined && previousSource !== source)
        throw new Error("Provider 실행 근거 item ID가 충돌합니다");
      if (previousSource !== undefined) continue;
      ids.set(id, source);
      const command = boundedRedactedText(item.command);
      const output = boundedRedactedText(item.aggregated_output ?? item.aggregatedOutput ?? "");
      const exitCode = item.exit_code ?? item.exitCode;
      if (!command || !output || exitCode !== 0) continue;
      const evidence: ExecutionEvidenceItem = {
        providerItemId: id,
        kind: "command",
        command: command.value,
        output: output.value,
        exitCode: 0,
        status: "completed",
        byteCount: command.byteCount + output.byteCount,
        ...(command.truncated || output.truncated ? { truncated: true as const } : {}),
      };
      if (byteCount + itemBytes(evidence) > MAXIMUM_EVIDENCE_BYTES) {
        truncated = true;
        continue;
      }
      observed.push(evidence);
      byteCount += itemBytes(evidence);
      continue;
    }
    if (
      (item.type === "file_change" || item.type === "fileChange") &&
      item.status === "completed" &&
      Array.isArray(item.changes)
    ) {
      const source = createHash("sha256").update(canonical(item)).digest("hex");
      const previousSource = rawItemIds.get(id);
      if (previousSource !== undefined && previousSource !== source)
        throw new Error("Provider 실행 근거 item ID가 충돌합니다");
      if (previousSource !== undefined) continue;
      rawItemIds.set(id, source);
      for (const [index, change] of item.changes.entries()) {
        if (!change || typeof change !== "object" || Array.isArray(change)) continue;
        const path = workspaceRelativePath((change as Record<string, unknown>).path, workspaceRoot);
        const kind = changeKind((change as Record<string, unknown>).kind);
        if (!path || !kind) continue;
        const providerItemId = `${id}:${String(index)}`;
        const source = createHash("sha256").update(canonical(change)).digest("hex");
        const previousSource = ids.get(providerItemId);
        if (previousSource !== undefined && previousSource !== source)
          throw new Error("Provider 실행 근거 item ID가 충돌합니다");
        if (previousSource !== undefined) continue;
        ids.set(providerItemId, source);
        const evidence: ExecutionEvidenceItem = {
          providerItemId,
          kind: "file",
          path,
          changeKind: kind,
          status: "completed",
        };
        if (byteCount + itemBytes(evidence) > MAXIMUM_EVIDENCE_BYTES) {
          truncated = true;
          continue;
        }
        observed.push(evidence);
        byteCount += itemBytes(evidence);
      }
    }
  }
  if (observed.length === 0) return undefined;
  const checksum = executionEvidenceChecksum(observed);
  return {
    items: observed,
    checksum,
    byteCount: executionEvidenceByteCount(observed),
    ...(truncated ? { truncated: true as const } : {}),
  };
}
