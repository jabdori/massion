export const APPROVAL_PREVIEW_REDACTION = "[민감값 제거]";
const INTERNAL_REDACTION = "[REDACTED]";

export type ApprovalDisplayPreview =
  | {
      readonly kind: "command";
      readonly title: string;
      readonly executable: string;
      readonly arguments: readonly string[];
      readonly cwd?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "file-change";
      readonly title: string;
      readonly path: string;
      readonly summary: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "provider";
      readonly title: string;
      readonly reason?: string;
    };

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const SENSITIVE_NAME =
  "(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|authorization|auth|password|passwd|secret|credential|cookie|session)";
const SENSITIVE_ASSIGNMENT = new RegExp(`(${SENSITIVE_NAME})(\\s*[:=]\\s*)(?:Bearer\\s+)?[^\\s&,;]+`, "giu");
const BEARER_VALUE = /\bBearer\s+[^\s&,;]+/giu;
const ENVIRONMENT_ASSIGNMENT = /(^|\s)([A-Z_][A-Z0-9_]{1,127})=([^\s]+)/gu;
const SENSITIVE_FLAG = new RegExp(`^--?${SENSITIVE_NAME}$`, "iu");

function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("승인 표시 미리보기는 일반 object여야 합니다");
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`승인 표시 미리보기에 알 수 없는 필드가 있습니다: ${unknown}`);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maximumBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

function removeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0);
    return code !== undefined && ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) ? " " : character;
  }).join("");
}

function displayText(value: unknown, label: string, maximum: number, maximumBytes = maximum): string {
  if (typeof value !== "string") throw new Error(`${label} 문자열이 유효하지 않습니다`);
  const sanitized = truncateUtf8(
    removeControlCharacters(value.replace(ANSI_SEQUENCE, ""))
      .replace(SENSITIVE_ASSIGNMENT, `$1$2${INTERNAL_REDACTION}`)
      .replace(BEARER_VALUE, INTERNAL_REDACTION)
      .replace(ENVIRONMENT_ASSIGNMENT, `$1$2=${INTERNAL_REDACTION}`)
      .replaceAll(INTERNAL_REDACTION, APPROVAL_PREVIEW_REDACTION)
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, maximum),
    maximumBytes,
  );
  if (!sanitized) throw new Error(`${label} 문자열이 비어 있습니다`);
  return sanitized;
}

function commandArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("승인 명령 인수 배열이 유효하지 않습니다");
  const result: string[] = [];
  let redactNext = false;
  for (const item of value.slice(0, 16)) {
    if (typeof item !== "string") throw new Error("승인 명령 인수는 문자열이어야 합니다");
    if (redactNext) {
      result.push(APPROVAL_PREVIEW_REDACTION);
      redactNext = false;
      continue;
    }
    const sanitized = displayText(item, "승인 명령 인수", 256, 256);
    result.push(sanitized);
    if (SENSITIVE_FLAG.test(sanitized)) redactNext = true;
  }
  return result;
}

export function normalizeApprovalDisplayPreview(value: unknown): ApprovalDisplayPreview {
  const source = record(value);
  if (source.kind === "command") {
    exactFields(source, ["kind", "title", "executable", "arguments", "cwd", "reason"]);
    const cwd = source.cwd === undefined ? undefined : displayText(source.cwd, "승인 명령 작업 경로", 512, 1_024);
    const reason = source.reason === undefined ? undefined : displayText(source.reason, "승인 요청 이유", 500, 1_000);
    return {
      kind: "command",
      title: displayText(source.title, "승인 요청 제목", 160, 480),
      executable: displayText(source.executable, "승인 실행 파일", 256, 512),
      arguments: commandArguments(source.arguments),
      ...(cwd === undefined ? {} : { cwd }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (source.kind === "file-change") {
    exactFields(source, ["kind", "title", "path", "summary", "reason"]);
    const reason = source.reason === undefined ? undefined : displayText(source.reason, "승인 요청 이유", 500, 1_000);
    return {
      kind: "file-change",
      title: displayText(source.title, "승인 요청 제목", 160, 480),
      path: displayText(source.path, "승인 파일 경로", 1_024, 2_048),
      summary: displayText(source.summary, "승인 변경 요약", 500, 1_000),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (source.kind === "provider") {
    exactFields(source, ["kind", "title", "reason"]);
    const reason = source.reason === undefined ? undefined : displayText(source.reason, "승인 요청 이유", 500, 1_000);
    return {
      kind: "provider",
      title: displayText(source.title, "승인 요청 제목", 160, 480),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  throw new Error("승인 표시 미리보기 종류가 유효하지 않습니다");
}

export function decodeApprovalDisplayPreview(value: unknown): ApprovalDisplayPreview | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return normalizeApprovalDisplayPreview(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}
