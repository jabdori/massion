export type IntegrationPlatform = "slack" | "discord" | "github";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DELIVERY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function validateTree(value: unknown, depth: number): void {
  if (depth > 20) throw new Error("외부 JSON 깊이 상한을 초과했습니다");
  if (typeof value === "string" && value.length > 64 * 1024) throw new Error("외부 JSON 문자열 상한을 초과했습니다");
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("외부 JSON 배열 상한을 초과했습니다");
    for (const child of value) validateTree(child, depth + 1);
    Object.freeze(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("외부 JSON prototype key를 허용하지 않습니다");
    }
    validateTree(child, depth + 1);
  }
  Object.freeze(value);
}

export function decodeExternalJson(body: Buffer, maximum = 1024 * 1024): unknown {
  if (body.length === 0 || body.length > maximum) throw new Error("외부 request body byte 상한이 유효하지 않습니다");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("외부 request body UTF-8이 유효하지 않습니다");
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("외부 request JSON이 유효하지 않습니다");
  }
  validateTree(value, 0);
  return value;
}

export function normalizeDeliveryId(_platform: IntegrationPlatform, value: string): string {
  if (!DELIVERY_PATTERN.test(value)) throw new Error("외부 delivery ID가 유효하지 않습니다");
  return value;
}

export function normalizeExternalId(_platform: IntegrationPlatform, value: string): string {
  if (!ID_PATTERN.test(value)) throw new Error("외부 식별자가 유효하지 않습니다");
  return value;
}
