const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const PROTOTYPE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly",
  "prepare",
  "dependencies",
]);
const CREDENTIAL =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s:@/]+:[^\s@/]+@/iu;

export function assertSafeArchivePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith("/") ||
    WINDOWS_ABSOLUTE.test(path) ||
    path.includes("\\") ||
    path.includes("//")
  ) {
    throw new Error(`Extension archive path가 유효하지 않습니다: ${path}`);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".." || PROTOTYPE_SEGMENTS.has(segment),
    )
  ) {
    throw new Error(`Extension archive path가 유효하지 않습니다: ${path}`);
  }
  if (segments[0] !== "package" || segments.length < 2) {
    throw new Error(`Extension archive path는 package/ 아래여야 합니다: ${path}`);
  }
  return segments.slice(1).join("/");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}은 object여야 합니다`);
  return value as Record<string, unknown>;
}

export function validatePackageSecurity(value: unknown): Readonly<Record<string, unknown>> {
  const packageJson = object(value, "package.json");
  const scripts = packageJson.scripts === undefined ? {} : object(packageJson.scripts, "package scripts");
  const forbiddenScript = Object.keys(scripts).find((name) => LIFECYCLE_SCRIPTS.has(name));
  if (forbiddenScript) throw new Error(`Extension package lifecycle script를 허용하지 않습니다: ${forbiddenScript}`);
  if (packageJson.gypfile === true || packageJson.binary !== undefined) {
    throw new Error("Extension package native addon 설정을 허용하지 않습니다");
  }
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ] as const) {
    if (packageJson[field] !== undefined) {
      throw new Error(`Extension package는 self-contained bundle이어야 합니다: ${field}`);
    }
  }
  return packageJson;
}

export function assertSafeExtensionFile(path: string): void {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower === "binding.gyp" || lower.endsWith(".node")) {
    throw new Error(`Extension archive에 native addon을 포함할 수 없습니다: ${path}`);
  }
  if (lower === "node_modules" || lower.startsWith("node_modules/") || lower.includes("/node_modules/")) {
    throw new Error(`Extension archive에 node_modules를 포함할 수 없습니다: ${path}`);
  }
}

export function assertNoEmbeddedCredential(path: string, body: Buffer): void {
  if (body.length > 1024 * 1024 || body.includes(0)) return;
  if (CREDENTIAL.test(body.toString("utf8"))) {
    throw new Error(`Extension package에서 credential 후보를 탐지했습니다: ${path}`);
  }
}
