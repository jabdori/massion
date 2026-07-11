export interface GrowthSecurityLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxOperations?: number;
}

const SECRET =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s:@/]+:[^\s@/]+@/iu;
const DANGEROUS_URI = /^\s*(?:file|javascript):/iu;
const TRAVERSAL = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
const UNIX_ABSOLUTE = /^\s*\/(?!\/)[^\r\n]*$/u;
const WINDOWS_ABSOLUTE = /^\s*[A-Za-z]:[\\/]/u;

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertString(value: string): void {
  if (SECRET.test(value)) throw new Error("Growth 보안 검증이 secret 또는 credential을 탐지했습니다");
  if (DANGEROUS_URI.test(value)) throw new Error("Growth 보안 검증이 위험 URI를 탐지했습니다");
  if (TRAVERSAL.test(value)) throw new Error("Growth 보안 검증이 traversal path를 탐지했습니다");
  if (UNIX_ABSOLUTE.test(value) || WINDOWS_ABSOLUTE.test(value)) {
    throw new Error("Growth 보안 검증이 absolute path를 탐지했습니다");
  }
}

export function assertGrowthSecurity(value: unknown, limits: GrowthSecurityLimits = {}): void {
  const maxBytes = limits.maxBytes ?? 1024 * 1024;
  const maxDepth = limits.maxDepth ?? 12;
  const maxOperations = limits.maxOperations ?? 2048;
  const encoded = typeof value === "string" ? value : canonicalJson(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("Growth 보안 byte 상한을 초과했습니다");
  let operations = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > maxDepth) throw new Error("Growth 보안 patch 깊이 상한을 초과했습니다");
    if (typeof candidate === "string") {
      assertString(candidate);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const children = Array.isArray(candidate) ? candidate : Object.values(candidate as Record<string, unknown>);
    operations += children.length;
    if (operations > maxOperations) throw new Error("Growth 보안 operation 상한을 초과했습니다");
    for (const child of children) visit(child, depth + 1);
  };
  visit(value, 0);
}

export function validateGrowthSuggestionSecurity(input: {
  readonly patch: Readonly<Record<string, unknown>>;
  readonly sourceReferenceIds: readonly string[];
}): void {
  if (input.sourceReferenceIds.length === 0 || input.sourceReferenceIds.length > 100)
    throw new Error("Growth 보안 source 상한은 1~100개입니다");
  assertGrowthSecurity(input, { maxBytes: 256 * 1024, maxDepth: 8, maxOperations: 256 });
}
