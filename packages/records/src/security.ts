export const RECORDS_DOCUMENT_MAX_BYTES = 1_048_576;
export const RECORDS_REFERENCE_MAX_COUNT = 100;

const UNSAFE_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "상위 경로", pattern: /(?:^|[\s"'(])\.\.[/\\]/u },
  {
    name: "POSIX 절대 경로",
    pattern: /(?:^|\s)\/(?:Users|home|var|etc|opt|root|private|tmp|srv|mnt|Volumes|usr|bin|sbin|Library|System)\//iu,
  },
  { name: "Windows 절대 경로", pattern: /(?:^|\s)[a-z]:\\/iu },
  { name: "위험 URI", pattern: /\b(?:file|javascript):/iu },
  { name: "private key", pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/iu },
  {
    name: "credential connection string",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|surrealdb|https?|wss?):\/\/[^\s:@/]+:[^@\s/]+@/iu,
  },
  { name: "raw HTML", pattern: /<\/?[a-z][^>]*>/iu },
  { name: "credential literal", pattern: /\b(?:api[_-]?key|password|secret)\s*[:=]\s*[^\s]{8,}/iu },
];

function validateReferenceCollection(value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new Error(`${path}는 reference 배열이어야 합니다`);
  if (value.length > RECORDS_REFERENCE_MAX_COUNT) throw new Error(`${path}는 100개 이하여야 합니다`);
  const references: string[] = [];
  for (const candidate of value as unknown[]) {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 200) {
      throw new Error(`${path}의 reference ID는 1~200자여야 합니다`);
    }
    references.push(candidate);
  }
  if (new Set(references).size !== references.length) throw new Error(`${path}에는 중복 reference가 있습니다`);
}

function inspect(value: unknown, path: string, seen: Set<object>): void {
  if (typeof value === "string") {
    for (const unsafe of UNSAFE_PATTERNS) {
      if (unsafe.pattern.test(value)) throw new Error(`Document에 ${unsafe.name}을 포함할 수 없습니다: ${path}`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("Document source는 순환 참조를 포함할 수 없습니다");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) inspect(child, `${path}[${String(index)}]`, seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (key === "sourceReferenceIds") validateReferenceCollection(child, `${path}.${key}`);
      inspect(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function validateDocumentSecurity(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Document source는 JSON으로 직렬화할 수 있어야 합니다");
  }
  if (new TextEncoder().encode(serialized).byteLength > RECORDS_DOCUMENT_MAX_BYTES) {
    throw new Error("Document source는 UTF-8 1 MiB 이하여야 합니다");
  }
  inspect(value, "$", new Set());
}
