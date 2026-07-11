import {
  EXTENSION_RPC_PROTOCOL,
  EXTENSION_SCHEMA_VERSION,
  type ExtensionManifestV1,
} from "./contracts.js";

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const PACKAGE_NAME = /^@massion-ext\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[opusr]|sk|pk)_[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/iu;
const TOP_FIELDS = new Set([
  "schemaVersion",
  "name",
  "version",
  "displayName",
  "description",
  "license",
  "compatibility",
  "runtime",
  "permissions",
  "contributions",
  "migration",
  "uninstall",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}은 object여야 합니다`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  const result = record(value, label);
  const unknown = Object.keys(result).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
  return result;
}

function text(value: unknown, label: string, max = 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${label} 문자열 길이가 유효하지 않습니다`);
  }
  if (SECRET.test(value)) throw new Error(`${label}에 secret 또는 credential을 넣을 수 없습니다`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} 정수 범위가 유효하지 않습니다`);
  }
  return value as number;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}은 배열이어야 합니다`);
  if (value.length > 256) throw new Error(`${label} 배열 상한을 초과했습니다`);
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}에 중복 값이 있습니다`);
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!IDENTIFIER.test(result)) throw new Error(`${label} 식별자가 유효하지 않습니다`);
  return result;
}

function validateTree(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error("Extension manifest 깊이 상한을 초과했습니다");
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value) && value.length > 256) throw new Error("Extension manifest 배열 상한을 초과했습니다");
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Extension manifest에 prototype key를 사용할 수 없습니다");
    }
    validateTree(child, depth + 1);
  }
}

function validatePermissions(value: unknown): void {
  const permissions = exact(
    value,
    new Set(["tools", "network", "files", "secrets", "process", "mcp", "storage", "events"]),
    "permissions",
  );
  const tools = list(permissions.tools, "permissions.tools").map((candidate, index) => {
    const tool = exact(candidate, new Set(["id", "operations"]), `permissions.tools[${index}]`);
    const id = identifier(tool.id, `permissions.tools[${index}].id`);
    const operations = list(tool.operations, `permissions.tools[${index}].operations`).map((operation) =>
      identifier(operation, "tool operation"),
    );
    unique(operations, `permissions.tools[${index}].operations`);
    return id;
  });
  unique(tools, "permissions.tools");

  const origins = list(permissions.network, "permissions.network").map((candidate, index) => {
    const network = exact(candidate, new Set(["origin", "methods"]), `permissions.network[${index}]`);
    const origin = text(network.origin, `permissions.network[${index}].origin`, 512);
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`permissions.network[${index}].origin이 유효하지 않습니다`);
    }
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.hostname.includes("*")) {
      throw new Error(`permissions.network[${index}].origin은 wildcard 없는 HTTPS origin이어야 합니다`);
    }
    const methods = list(network.methods, `permissions.network[${index}].methods`).map((method) =>
      text(method, "network method", 8),
    );
    if (methods.some((method) => !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))) {
      throw new Error("network method가 유효하지 않습니다");
    }
    unique(methods, `permissions.network[${index}].methods`);
    return origin;
  });
  unique(origins, "permissions.network");

  const mounts = list(permissions.files, "permissions.files").map((candidate, index) => {
    const file = exact(candidate, new Set(["mount", "access"]), `permissions.files[${index}]`);
    const mount = identifier(file.mount, `permissions.files[${index}].mount`);
    if (file.access !== "read" && file.access !== "write") throw new Error("file access가 유효하지 않습니다");
    return mount;
  });
  unique(mounts, "permissions.files");

  const slots = list(permissions.secrets, "permissions.secrets").map((candidate, index) => {
    const secret = exact(candidate, new Set(["slot", "purpose"]), `permissions.secrets[${index}]`);
    const slot = identifier(secret.slot, `permissions.secrets[${index}].slot`);
    text(secret.purpose, `permissions.secrets[${index}].purpose`, 512);
    return slot;
  });
  unique(slots, "permissions.secrets");

  for (const field of ["process", "mcp", "events"] as const) {
    const values = list(permissions[field], `permissions.${field}`).map((candidate) =>
      identifier(candidate, `permissions.${field}`),
    );
    unique(values, `permissions.${field}`);
  }
  const storage = exact(permissions.storage, new Set(["quotaBytes", "maxValueBytes"]), "permissions.storage");
  const quota = integer(storage.quotaBytes, "storage quota", 0, 1024 * 1024 * 1024);
  const maximum = integer(storage.maxValueBytes, "storage value", 0, 1024 * 1024);
  if (maximum > quota) throw new Error("storage maxValueBytes가 quotaBytes보다 클 수 없습니다");
}

function validateContributions(value: unknown): void {
  const fields = [
    "runtimeTools",
    "organizationTemplates",
    "growthSignals",
    "growthTargets",
    "surfaceConnectors",
    "eventConsumers",
    "skills",
  ] as const;
  const contributions = exact(value, new Set(fields), "contributions");
  const all: string[] = [];
  for (const field of fields) {
    const ids = list(contributions[field], `contributions.${field}`).map((candidate, index) => {
      const entry = exact(
        candidate,
        field === "skills" ? new Set(["id", "path"]) : new Set(["id", "handler"]),
        `contributions.${field}[${index}]`,
      );
      const id = identifier(entry.id, `contributions.${field}[${index}].id`);
      const target = text(field === "skills" ? entry.path : entry.handler, `contributions.${field}[${index}] target`, 256);
      if (target.startsWith("/") || target.includes("\\") || target.split("/").includes("..")) {
        throw new Error(`contributions.${field}[${index}] path가 유효하지 않습니다`);
      }
      return id;
    });
    unique(ids, `contributions.${field}`);
    all.push(...ids.map((id) => `${field}:${id}`));
  }
  unique(all, "contributions");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function validateExtensionManifest(value: unknown): ExtensionManifestV1 {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 64 * 1024) {
    throw new Error("Extension manifest byte 상한을 초과했습니다");
  }
  validateTree(value);
  const manifest = exact(value, TOP_FIELDS, "manifest");
  if (manifest.schemaVersion !== EXTENSION_SCHEMA_VERSION) throw new Error("Extension schemaVersion이 유효하지 않습니다");
  const name = text(manifest.name, "Extension name", 128);
  if (!PACKAGE_NAME.test(name)) throw new Error("Extension name은 @massion-ext scope여야 합니다");
  const version = text(manifest.version, "Extension version", 128);
  if (!SEMVER.test(version)) throw new Error("Extension version은 SemVer여야 합니다");
  text(manifest.displayName, "displayName", 128);
  text(manifest.description, "description", 4096);
  text(manifest.license, "license", 128);

  const compatibility = exact(manifest.compatibility, new Set(["agentOS", "node", "surrealDB"]), "compatibility");
  text(compatibility.agentOS, "compatibility.agentOS", 128);
  text(compatibility.node, "compatibility.node", 128);
  if (compatibility.surrealDB !== undefined) text(compatibility.surrealDB, "compatibility.surrealDB", 128);

  const runtime = exact(
    manifest.runtime,
    new Set(["entrypoint", "protocol", "healthTimeoutMs", "stopTimeoutMs"]),
    "runtime",
  );
  const entrypoint = text(runtime.entrypoint, "runtime entrypoint", 256);
  if (
    entrypoint.startsWith("/") ||
    entrypoint.includes("\\") ||
    entrypoint.split("/").includes("..") ||
    !entrypoint.endsWith(".js")
  ) {
    throw new Error("runtime entrypoint는 package 내부 JavaScript path여야 합니다");
  }
  if (runtime.protocol !== EXTENSION_RPC_PROTOCOL) throw new Error("runtime protocol이 유효하지 않습니다");
  integer(runtime.healthTimeoutMs, "health timeout", 100, 60_000);
  integer(runtime.stopTimeoutMs, "stop timeout", 100, 60_000);

  validatePermissions(manifest.permissions);
  validateContributions(manifest.contributions);
  if (manifest.migration !== undefined) {
    const migration = exact(manifest.migration, new Set(["schemaVersion", "operations"]), "migration");
    identifier(migration.schemaVersion, "migration.schemaVersion");
    list(migration.operations, "migration.operations");
  }
  const uninstall = exact(manifest.uninstall, new Set(["retention"]), "uninstall");
  if (uninstall.retention !== "retain" && uninstall.retention !== "delete-after-export") {
    throw new Error("uninstall retention이 유효하지 않습니다");
  }
  return value as ExtensionManifestV1;
}

export function defineExtension(value: unknown): ExtensionManifestV1 {
  const cloned = structuredClone(value);
  return deepFreeze(validateExtensionManifest(cloned));
}
