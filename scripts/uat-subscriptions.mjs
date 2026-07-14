import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{1,127}$/u;
const PREREQUISITES = new Set([
  "missing-account",
  "missing-quota-contract",
  "provider-approval-required",
  "interactive-login-required",
  "external-service-unavailable",
  "public-provider-connect-unavailable",
  "public-failure-injection-unavailable",
  "second-account-required",
  "second-user-required",
  "approval-checkpoint-required",
]);
const FAILURE_CLASSES = new Set(["authentication", "quota", "network", "provider", "product", "cancelled"]);
const FORBIDDEN_KEY =
  /(?:token|secret|credential|cookie|authorization|email|profile(?:path|root)?|stdout|stderr|output|privatekey)/iu;
const FORBIDDEN_STRING = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/iu,
  /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/u,
  /\b(?:sk-(?:ant-)?|ghp_)[A-Za-z0-9_-]{12,}\b/u,
  /(?:^|[\s"'(])\/(?:Volumes|Users|home|private|tmp|var)\/[^\s"'<>]*/u,
  /\bfile:\/\/\/[^\s"'<>]+/iu,
  /[A-Za-z]:\\Users\\[^\s]+/u,
];
const RELEASE_ARCHIVE = /^massion-local-(\d+\.\d+\.\d+)\.tar\.gz$/u;
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+$/u;
const PROVIDER_NAMES = new Set(["codex", "claude", "zai"]);
const TMUX_WINDOWS = ["daemon", "user", "connectors", "watch"];
const REQUIRED_ENTRYPOINTS = {
  mass: "runtime/node_modules/@massion/cli/dist/main.js",
  connector: "runtime/node_modules/@massion/connector/dist/main.js",
  server: "runtime/node_modules/@massion/server/dist/main.js",
  tui: "runtime/node_modules/@massion/tui/dist/main.js",
};
const DEFAULT_TIMEOUT_MS = 120_000;
const MAXIMUM_TIMEOUT_MS = 15 * 60_000;
const MAXIMUM_OBSERVED_OUTPUT_BYTES = 1024 * 1024;
const OBSERVATION_SCHEMA = "massion.subscription-uat-observation.v1";
const OBSERVATION_KINDS = new Set([
  "application-run-terminal",
  "application-status",
  "connector-doctor",
  "exact-text",
  "initialize-owner",
  "local-backup",
  "local-start",
  "local-stop",
  "runtime-subscription-lineage",
  "server-restore",
  "subscription-accounts",
  "subscription-doctor",
  "subscription-policy-command",
  "subscription-policy-query",
  "subscription-providers",
  "subscription-quota",
]);

// 비대화형 UAT는 사용자의 승인 입력을 기다리지 않고, 실제 실행 완료 여부를 검증합니다.
// review 정책의 승인 전달은 별도 상호작용 시나리오에서 검증합니다.
export function subscriptionUatPolicy(providerId) {
  return {
    providerId,
    credentialPolicy: "adaptive",
    approvalMode: "automatic",
  };
}

export function subscriptionUatRunPlan(correlationId) {
  if (
    typeof correlationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(correlationId)
  ) {
    throw new Error("UAT run correlation ID가 UUID 형식이 아닙니다");
  }
  return {
    correlationId,
    runArguments: ["run", "subscription acceptance", "--correlation", correlationId, "--json"],
    lineageArguments: ["runtime", "lineage", "correlation", correlationId, "--json"],
  };
}

function fail(message) {
  throw new Error(`Subscription UAT 영수증 ${message}`);
}

function plainObject(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label}은 object여야 합니다`);
  }
  return value;
}

function exact(value, fields, label) {
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown) fail(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
}

function safeName(value, label) {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) fail(`${label}가 유효하지 않습니다`);
  return value;
}

function instant(value, label) {
  if (typeof value !== "string") fail(`${label}가 유효하지 않습니다`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(`${label}가 유효하지 않습니다`);
  return parsed;
}

function scanSensitive(value, path = "receipt", ancestors = new Set()) {
  if (typeof value === "string") {
    if (FORBIDDEN_STRING.some((pattern) => pattern.test(value))) fail(`${path}에 비밀·개인정보·로컬 경로가 있습니다`);
    return;
  }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (!value || typeof value !== "object") fail(`${path} 값이 JSON-safe하지 않습니다`);
  if (ancestors.has(value)) fail(`${path}에 순환 참조가 있습니다`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanSensitive(child, `${path}[${String(index)}]`, ancestors));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) fail(`${path}.${key}에 비밀 또는 개인정보 필드를 사용할 수 없습니다`);
      scanSensitive(child, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function validateCommand(value, scenarioId) {
  const command = plainObject(value, `${scenarioId} command`);
  exact(command, ["step", "exitCode"], `${scenarioId} command`);
  safeName(command.step, `${scenarioId} command step`);
  if (!Number.isSafeInteger(command.exitCode) || command.exitCode < 0 || command.exitCode > 255) {
    fail(`${scenarioId} command exit code가 유효하지 않습니다`);
  }
  return command;
}

function validateScenario(value) {
  const scenario = plainObject(value, "scenario");
  exact(
    scenario,
    [
      "id",
      "provider",
      "status",
      "startedAt",
      "endedAt",
      "assertions",
      "commands",
      "lineage",
      "prerequisite",
      "failureClass",
    ],
    "scenario",
  );
  const id = safeName(scenario.id, "scenario ID");
  safeName(scenario.provider, `${id} provider`);
  if (!new Set(["passed", "failed", "not-run"]).has(scenario.status)) fail(`${id} 상태가 유효하지 않습니다`);
  const startedAt = instant(scenario.startedAt, `${id} 시작 시각`);
  const endedAt = instant(scenario.endedAt, `${id} 종료 시각`);
  if (endedAt < startedAt) fail(`${id} 종료 시각이 시작보다 빠릅니다`);
  if (!Array.isArray(scenario.assertions) || scenario.assertions.length > 128)
    fail(`${id} 검증 목록이 유효하지 않습니다`);
  scenario.assertions.forEach((assertion) => safeName(assertion, `${id} 검증`));
  if (!Array.isArray(scenario.commands) || scenario.commands.length > 128)
    fail(`${id} command 목록이 유효하지 않습니다`);
  const commands = scenario.commands.map((command) => validateCommand(command, id));
  if (
    !Array.isArray(scenario.lineage) ||
    scenario.lineage.length > 128 ||
    scenario.lineage.some((item) => !SHA256.test(item))
  ) {
    fail(`${id} 계보 digest가 유효하지 않습니다`);
  }
  if (scenario.status === "passed") {
    if (
      scenario.assertions.length === 0 ||
      commands.length === 0 ||
      commands.some((command) => command.exitCode !== 0)
    ) {
      fail(`${id} 성공 상태가 실제 command·검증 결과와 일치하지 않습니다`);
    }
    if (scenario.prerequisite !== undefined || scenario.failureClass !== undefined)
      fail(`${id} 성공 상태에 실패 필드가 있습니다`);
  } else if (scenario.status === "not-run") {
    if (!PREREQUISITES.has(scenario.prerequisite)) fail(`${id} 미실행 선행조건이 필요합니다`);
    if (
      scenario.assertions.length > 0 ||
      commands.length > 0 ||
      scenario.lineage.length > 0 ||
      scenario.failureClass !== undefined
    ) {
      fail(`${id} 미실행 상태에 실행 결과가 있습니다`);
    }
  } else {
    if (!FAILURE_CLASSES.has(scenario.failureClass)) fail(`${id} 실패 분류가 필요합니다`);
    if (scenario.prerequisite !== undefined) fail(`${id} 실패 상태에 미실행 선행조건이 있습니다`);
  }
  return scenario;
}

export function validateSubscriptionUatReceipt(value) {
  scanSensitive(value);
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail("JSON 직렬화에 실패했습니다");
  }
  if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024) fail("byte 상한을 초과했습니다");
  const receipt = plainObject(value, "root");
  exact(
    receipt,
    ["schema", "gitCommit", "releaseDigest", "tmuxSession", "startedAt", "endedAt", "summary", "scenarios"],
    "root",
  );
  if (receipt.schema !== "massion.subscription-uat.v1") fail("schema가 유효하지 않습니다");
  if (typeof receipt.gitCommit !== "string" || !GIT_COMMIT.test(receipt.gitCommit))
    fail("Git commit이 유효하지 않습니다");
  if (typeof receipt.releaseDigest !== "string" || !SHA256.test(receipt.releaseDigest))
    fail("release digest가 유효하지 않습니다");
  safeName(receipt.tmuxSession, "tmux session");
  const startedAt = instant(receipt.startedAt, "시작 시각");
  const endedAt = instant(receipt.endedAt, "종료 시각");
  if (endedAt < startedAt) fail("종료 시각이 시작보다 빠릅니다");
  if (!Array.isArray(receipt.scenarios) || receipt.scenarios.length < 1 || receipt.scenarios.length > 128) {
    fail("scenario 수가 유효하지 않습니다");
  }
  const scenarios = receipt.scenarios.map(validateScenario);
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) fail("scenario ID가 중복됐습니다");
  const summary = plainObject(receipt.summary, "summary");
  exact(summary, ["passed", "failed", "notRun"], "summary");
  const expected = {
    passed: scenarios.filter((scenario) => scenario.status === "passed").length,
    failed: scenarios.filter((scenario) => scenario.status === "failed").length,
    notRun: scenarios.filter((scenario) => scenario.status === "not-run").length,
  };
  if (!Object.entries(expected).every(([key, count]) => summary[key] === count))
    fail("summary가 scenario 상태와 일치하지 않습니다");
  return value;
}

export function createSubscriptionUatReceipt(input) {
  const scenarios = Array.isArray(input.scenarios) ? input.scenarios : [];
  return validateSubscriptionUatReceipt({
    schema: "massion.subscription-uat.v1",
    gitCommit: input.gitCommit,
    releaseDigest: input.releaseDigest,
    tmuxSession: input.tmuxSession,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    summary: {
      passed: scenarios.filter((scenario) => scenario.status === "passed").length,
      failed: scenarios.filter((scenario) => scenario.status === "failed").length,
      notRun: scenarios.filter((scenario) => scenario.status === "not-run").length,
    },
    scenarios,
  });
}

function observedObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}은 object여야 합니다`);
  }
  return value;
}

function observedExact(value, fields, label) {
  const candidate = observedObject(value, label);
  const unknown = Object.keys(candidate).find((key) => !fields.includes(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
  return candidate;
}

function observedText(value, label, maximum = 16 * 1024) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} 문자열이 유효하지 않습니다`);
  }
  return value;
}

function observedIdentifier(value, label) {
  const candidate = observedText(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate)) throw new Error(`${label}가 유효하지 않습니다`);
  return candidate;
}

function observedInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

function observedStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length < 1)) {
    throw new Error(`${label} 목록이 유효하지 않습니다`);
  }
  return value;
}

function observedInstant(value, label) {
  const candidate = observedText(value, label, 64);
  if (new Date(candidate).toISOString() !== candidate) throw new Error(`${label} 시각이 유효하지 않습니다`);
  return candidate;
}

function expectedObservation(value) {
  return value === undefined ? {} : observedObject(value, "UAT 관찰 expected");
}

function queryData(value, operation) {
  const envelope = observedExact(value, ["schemaVersion", "operation", "data"], `${operation} query 응답`);
  if (envelope.schemaVersion !== "massion.application.v1" || envelope.operation !== operation) {
    throw new Error(`${operation} query 계보가 일치하지 않습니다`);
  }
  if (!Array.isArray(envelope.data)) throw new Error(`${operation} query data가 배열이 아닙니다`);
  return envelope.data;
}

function policyFacts(value, label) {
  const policy = observedExact(
    value,
    ["providerId", "credentialPolicy", "approvalMode", "version", "source", "updatedAt"],
    label,
  );
  const providerId = observedIdentifier(policy.providerId, `${label} providerId`);
  const credentialPolicy = observedIdentifier(policy.credentialPolicy, `${label} credentialPolicy`);
  const approvalMode = observedText(policy.approvalMode, `${label} approvalMode`, 16);
  if (!new Set(["automatic", "review", "deny"]).has(approvalMode)) {
    throw new Error(`${label} approvalMode이 유효하지 않습니다`);
  }
  const version = observedInteger(policy.version, `${label} version`, 0);
  if (policy.source !== "configured" && policy.source !== "default")
    throw new Error(`${label} source가 유효하지 않습니다`);
  if (policy.updatedAt !== undefined) observedInstant(policy.updatedAt, `${label} updatedAt`);
  return { approvalMode, credentialPolicy, providerId, source: policy.source, version };
}

function validateProviderRuntimeCapabilities(value, label) {
  const capabilities = observedExact(
    value,
    [
      "minimumVersion",
      "accountIsolation",
      "output",
      "cancellation",
      "session",
      "permissionBridge",
      "multipleAccounts",
      "maturity",
      "approvalModes",
      "approvalModesBySurface",
    ],
    label,
  );
  if (capabilities.minimumVersion !== undefined) {
    observedText(capabilities.minimumVersion, `${label} minimumVersion`, 64);
  }
  const contracts = [
    ["accountIsolation", ["profile-root", "single-os-keyring-account"]],
    ["output", ["structured-stream", "final-text-only"]],
    ["cancellation", ["protocol", "best-effort-process-tree"]],
    ["session", ["protocol", "explicit-existing-id-only"]],
    ["permissionBridge", ["protocol", "unsupported"]],
    ["multipleAccounts", ["profile-isolated", "one-account-per-connector"]],
    ["maturity", ["contract-tested", "experimental"]],
  ];
  for (const [field, allowed] of contracts) {
    if (!allowed.includes(capabilities[field])) throw new Error(`${label} ${field}가 유효하지 않습니다`);
  }
  if (capabilities.approvalModes !== undefined) {
    const approvalModes = observedStringArray(capabilities.approvalModes, `${label} approvalModes`);
    if (
      approvalModes.length < 1 ||
      new Set(approvalModes).size !== approvalModes.length ||
      approvalModes.some((mode) => !new Set(["automatic", "review", "deny"]).has(mode))
    ) {
      throw new Error(`${label} approvalModes가 유효하지 않습니다`);
    }
  }
  if (capabilities.approvalModesBySurface !== undefined) {
    const bySurface = observedExact(
      capabilities.approvalModesBySurface,
      ["server", "edge"],
      `${label} approvalModesBySurface`,
    );
    const declaredSurfaces = ["server", "edge"].filter((surface) => bySurface[surface] !== undefined);
    if (declaredSurfaces.length < 1) {
      throw new Error(`${label} approvalModesBySurface가 비어 있습니다`);
    }
    for (const surface of declaredSurfaces) {
      const approvalModes = observedStringArray(bySurface[surface], `${label} approvalModesBySurface ${surface}`);
      if (
        approvalModes.length < 1 ||
        new Set(approvalModes).size !== approvalModes.length ||
        approvalModes.some((mode) => !new Set(["automatic", "review", "deny"]).has(mode))
      ) {
        throw new Error(`${label} approvalModesBySurface ${surface}가 유효하지 않습니다`);
      }
    }
  }
}

function validateProviderCatalog(value, expected) {
  const providers = queryData(value, "subscription.providers").map((item, index) => {
    const provider = observedExact(
      item,
      [
        "providerId",
        "displayName",
        "authKinds",
        "executionKind",
        "connectionSurface",
        "billingKinds",
        "modelDiscovery",
        "quotaDiscovery",
        "protocols",
        "protocol",
        "availability",
        "officialDocumentation",
        "credentialPolicies",
        "runtimeCapabilities",
        "verified",
      ],
      `subscription.providers data[${String(index)}]`,
    );
    const providerId = observedIdentifier(provider.providerId, "subscription providerId");
    observedText(provider.displayName, "subscription provider displayName", 256);
    observedStringArray(provider.authKinds, "subscription provider authKinds");
    if (provider.executionKind !== "model" && provider.executionKind !== "agent-runtime") {
      throw new Error("subscription provider executionKind가 유효하지 않습니다");
    }
    if (!new Set(["server-and-edge", "server-only", "edge-only", "unavailable"]).has(provider.connectionSurface)) {
      throw new Error("subscription provider connectionSurface가 유효하지 않습니다");
    }
    observedStringArray(provider.billingKinds, "subscription provider billingKinds");
    observedText(provider.modelDiscovery, "subscription provider modelDiscovery", 64);
    observedText(provider.quotaDiscovery, "subscription provider quotaDiscovery", 64);
    observedStringArray(provider.protocols, "subscription provider protocols");
    if (provider.protocol !== undefined) observedText(provider.protocol, "subscription provider protocol", 64);
    if (!new Set(["supported", "experimental", "requires-provider-approval"]).has(provider.availability)) {
      throw new Error("subscription provider availability가 유효하지 않습니다");
    }
    observedText(provider.officialDocumentation, "subscription provider 공식 문서", 2048);
    observedStringArray(provider.credentialPolicies, "subscription provider credentialPolicies");
    if (provider.runtimeCapabilities !== undefined) {
      validateProviderRuntimeCapabilities(
        provider.runtimeCapabilities,
        `subscription.providers data[${String(index)}] runtimeCapabilities`,
      );
    }
    if (typeof provider.verified !== "boolean") throw new Error("subscription provider verified가 유효하지 않습니다");
    return {
      availability: provider.availability,
      connectionSurface: provider.connectionSurface,
      providerId,
      verified: provider.verified,
    };
  });
  const requiredProviders = Array.isArray(expected.providers) ? expected.providers : [];
  for (const required of requiredProviders) {
    const contract = observedObject(required, "필수 provider 계약");
    const matched = providers.find((provider) => provider.providerId === contract.providerId);
    if (
      !matched ||
      (contract.availability !== undefined && matched.availability !== contract.availability) ||
      (contract.connectionSurface !== undefined && matched.connectionSurface !== contract.connectionSurface)
    ) {
      throw new Error(`subscription provider 계약을 찾을 수 없습니다: ${String(contract.providerId)}`);
    }
  }
  return { providers: requiredProviders.map((provider) => provider.providerId) };
}

function validateAccountQuery(value, expected) {
  const accounts = queryData(value, "subscription.accounts").map((item, index) => {
    const account = observedExact(
      item,
      [
        "accountId",
        "providerId",
        "alias",
        "scope",
        "canManage",
        "connectorId",
        "connectorLocation",
        "connectorExecutionKind",
        "connectorStatus",
        "billingKind",
        "status",
        "version",
        "cooldownUntil",
        "windows",
        "minimumRemainingRatio",
        "earliestResetAt",
        "quotaExhausted",
        "quotaObservedAt",
      ],
      `subscription.accounts data[${String(index)}]`,
    );
    const facts = {
      accountId: observedIdentifier(account.accountId, "구독 accountId"),
      billingKind: observedText(account.billingKind, "구독 billingKind", 64),
      connectorExecutionKind: observedText(account.connectorExecutionKind, "구독 connectorExecutionKind", 32),
      connectorId: observedIdentifier(account.connectorId, "구독 connectorId"),
      connectorLocation: observedText(account.connectorLocation, "구독 connectorLocation", 32),
      providerId: observedIdentifier(account.providerId, "구독 providerId"),
      scope: observedText(account.scope, "구독 scope", 32),
      status: observedText(account.status, "구독 status", 32),
      version: observedInteger(account.version, "구독 account version", 1),
    };
    observedText(account.alias, "구독 account alias", 128);
    if (typeof account.canManage !== "boolean") throw new Error("구독 canManage가 유효하지 않습니다");
    if (account.connectorStatus !== undefined) observedText(account.connectorStatus, "구독 connectorStatus", 32);
    return { ...facts, alias: account.alias, canManage: account.canManage, connectorStatus: account.connectorStatus };
  });
  const matches = accounts.filter(
    (account) => account.providerId === expected.providerId && account.alias === expected.alias,
  );
  if (matches.length !== 1) throw new Error("검증할 구독 account 계보를 정확히 하나 찾지 못했습니다");
  const account = matches[0];
  if (
    account.status !== "active" ||
    account.scope !== "personal" ||
    account.canManage !== true ||
    account.connectorStatus !== "ready" ||
    account.billingKind !== (expected.billingKind ?? "consumer-subscription") ||
    account.connectorExecutionKind !== (expected.connectorExecutionKind ?? "agent-runtime") ||
    account.connectorLocation !== (expected.connectorLocation ?? "server")
  ) {
    throw new Error("구독 account 또는 Connector가 준비 상태가 아닙니다");
  }
  return {
    accountId: account.accountId,
    billingKind: account.billingKind,
    connectorExecutionKind: account.connectorExecutionKind,
    connectorId: account.connectorId,
    connectorLocation: account.connectorLocation,
    providerId: account.providerId,
    scope: account.scope,
    status: account.status,
    version: account.version,
  };
}

function validateDoctorQuery(value, expected) {
  const rows = queryData(value, "subscription.doctor").map((item, index) => {
    const row = observedExact(
      item,
      [
        "accountId",
        "providerId",
        "alias",
        "accountStatus",
        "connectorId",
        "connectorLocation",
        "connectorStatus",
        "quotaStatus",
        "earliestResetAt",
        "action",
      ],
      `subscription.doctor data[${String(index)}]`,
    );
    return {
      accountId: observedIdentifier(row.accountId, "doctor accountId"),
      accountStatus: observedText(row.accountStatus, "doctor accountStatus", 32),
      action: observedText(row.action, "doctor action", 32),
      connectorId: observedIdentifier(row.connectorId, "doctor connectorId"),
      connectorStatus: observedText(row.connectorStatus, "doctor connectorStatus", 32),
      providerId: observedIdentifier(row.providerId, "doctor providerId"),
      quotaStatus: observedText(row.quotaStatus, "doctor quotaStatus", 32),
    };
  });
  const matches = rows.filter(
    (row) =>
      row.accountId === expected.accountId &&
      row.providerId === expected.providerId &&
      row.connectorId === expected.connectorId,
  );
  if (matches.length !== 1) throw new Error("doctor account query 계보가 일치하지 않습니다");
  const row = matches[0];
  if (row.accountStatus !== "active" || row.connectorStatus !== "ready" || row.action !== "none") {
    throw new Error("provider doctor 건강 상태가 ready가 아닙니다");
  }
  if (row.quotaStatus !== "available" && row.quotaStatus !== "unknown") {
    throw new Error("provider doctor quota 상태가 유효하지 않습니다");
  }
  return row;
}

function validateQuotaQuery(value, expected) {
  const rows = queryData(value, "subscription.quota");
  if (rows.length === 0) return { accountId: expected.accountId, available: false };
  const quotas = rows.map((item, index) => {
    const quota = observedExact(
      item,
      ["accountId", "windows", "minimumRemainingRatio", "earliestResetAt", "exhausted", "observedAt"],
      `subscription.quota data[${String(index)}]`,
    );
    const accountId = observedIdentifier(quota.accountId, "quota accountId");
    if (!Array.isArray(quota.windows)) throw new Error("quota windows가 배열이 아닙니다");
    quota.windows.forEach((item, windowIndex) => {
      const window = observedExact(
        item,
        ["kind", "limit", "remaining", "remainingRatio", "resetsAt", "observedAt", "confidence"],
        `quota window[${String(windowIndex)}]`,
      );
      observedText(window.kind, "quota window kind", 64);
      observedInstant(window.observedAt, "quota window observedAt");
      if (window.resetsAt !== undefined) observedInstant(window.resetsAt, "quota window resetsAt");
      if (window.confidence !== undefined) observedText(window.confidence, "quota window confidence", 64);
      for (const field of ["limit", "remaining", "remainingRatio"]) {
        if (window[field] !== undefined && (typeof window[field] !== "number" || !Number.isFinite(window[field]))) {
          throw new Error(`quota window ${field}가 유효하지 않습니다`);
        }
      }
    });
    if (typeof quota.exhausted !== "boolean") throw new Error("quota exhausted가 유효하지 않습니다");
    observedInstant(quota.observedAt, "quota observedAt");
    return { accountId, available: true, exhausted: quota.exhausted, windows: quota.windows.length };
  });
  const matches = quotas.filter((quota) => quota.accountId === expected.accountId);
  if (matches.length !== 1) throw new Error("quota account query 계보가 일치하지 않습니다");
  return matches[0];
}

function validatePolicyCommand(value, expected) {
  const response = observedExact(
    value,
    ["schemaVersion", "commandId", "correlationId", "operation", "outcome", "resource", "data"],
    "subscription policy command 응답",
  );
  if (
    response.schemaVersion !== "massion.application.v1" ||
    response.operation !== "subscription.policy.configure" ||
    response.outcome !== "succeeded"
  ) {
    throw new Error("subscription policy command outcome 또는 계보가 완료 상태가 아닙니다");
  }
  observedIdentifier(response.commandId, "policy commandId");
  observedIdentifier(response.correlationId, "policy correlationId");
  const facts = policyFacts(response.data, "subscription policy command data");
  const resource = observedExact(response.resource, ["type", "id", "revision"], "subscription policy resource");
  if (
    resource.type !== "SubscriptionPolicy" ||
    resource.id !== facts.providerId ||
    resource.revision !== facts.version ||
    facts.providerId !== expected.providerId ||
    facts.credentialPolicy !== expected.credentialPolicy ||
    (expected.approvalMode !== undefined && facts.approvalMode !== expected.approvalMode) ||
    facts.source !== "configured"
  ) {
    throw new Error("subscription policy command provider·policy·resource 계보가 일치하지 않습니다");
  }
  return facts;
}

function validatePolicyQuery(value, expected) {
  const policies = queryData(value, "subscription.policy").map((item, index) =>
    policyFacts(item, `subscription.policy data[${String(index)}]`),
  );
  const matches = policies.filter(
    (policy) =>
      policy.providerId === expected.providerId &&
      (expected.credentialPolicy === undefined || policy.credentialPolicy === expected.credentialPolicy) &&
      (expected.approvalMode === undefined || policy.approvalMode === expected.approvalMode) &&
      (expected.version === undefined || policy.version === expected.version),
  );
  if (matches.length !== 1 || matches[0].source !== "configured") {
    throw new Error("subscription policy query 계보가 일치하지 않습니다");
  }
  return matches[0];
}

function canonicalObservation(value) {
  if (Array.isArray(value)) return value.map(canonicalObservation);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalObservation(child)]),
    );
  }
  return value;
}

function observationDigest(kind, facts) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalObservation({ kind, facts })))
    .digest("hex")}`;
}

export function parseAndValidateObservedUatOutput(kind, raw, expectedValue = {}) {
  if (!OBSERVATION_KINDS.has(kind)) throw new Error(`지원하지 않는 UAT 관찰 종류입니다: ${String(kind)}`);
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAXIMUM_OBSERVED_OUTPUT_BYTES) {
    throw new Error("UAT 관찰 JSON byte 길이가 유효하지 않습니다");
  }
  const expected = expectedObservation(expectedValue);
  let value;
  if (kind === "exact-text") {
    value = raw.trim();
  } else {
    try {
      value = JSON.parse(raw.trim());
    } catch {
      throw new Error("UAT 관찰 JSON을 해석할 수 없습니다");
    }
  }
  let facts;
  if (kind === "exact-text") {
    if (value !== expected.value) throw new Error("UAT text 출력이 기대값과 일치하지 않습니다");
    facts = { matched: true };
  } else if (kind === "connector-doctor") {
    const doctor = observedExact(value, ["schema", "status", "runtime"], "Connector doctor 응답");
    if (doctor.schema !== "massion.connector-doctor.v1" || doctor.status !== "ready" || doctor.runtime !== "bundled") {
      throw new Error("Connector doctor 상태가 ready/bundled가 아닙니다");
    }
    facts = { runtime: doctor.runtime, status: doctor.status };
  } else if (kind === "local-start") {
    const started = observedExact(value, ["status", "pid", "endpoint"], "local start 응답");
    if (started.status !== (expected.status ?? "started") || started.endpoint !== expected.endpoint) {
      throw new Error("local start 상태 또는 endpoint가 일치하지 않습니다");
    }
    observedInteger(started.pid, "local server pid", 1);
    facts = { endpoint: started.endpoint, status: started.status };
  } else if (kind === "local-stop") {
    const stopped = observedExact(value, ["status", "pid"], "local stop 응답");
    const allowed = expected.statuses ?? ["stopped", "already-stopped"];
    if (!Array.isArray(allowed) || !allowed.includes(stopped.status))
      throw new Error("local stop 상태가 유효하지 않습니다");
    if (stopped.pid !== undefined) observedInteger(stopped.pid, "local stop pid", 1);
    facts = { status: stopped.status };
  } else if (kind === "local-backup") {
    const backup = observedExact(value, ["status", "path"], "local backup 응답");
    if (backup.status !== "backed-up" || backup.path !== expected.path) {
      throw new Error("local backup 상태 또는 경로가 일치하지 않습니다");
    }
    facts = { status: backup.status };
  } else if (kind === "initialize-owner") {
    const initialized = observedExact(value, ["profile", "endpoint", "tokenId"], "init 응답");
    if (initialized.profile !== (expected.profile ?? "local") || initialized.endpoint !== expected.endpoint) {
      throw new Error("init profile 또는 endpoint 계보가 일치하지 않습니다");
    }
    observedIdentifier(initialized.tokenId, "init tokenId");
    facts = { endpoint: initialized.endpoint, profile: initialized.profile };
  } else if (kind === "application-status") {
    const envelope = observedExact(value, ["schemaVersion", "operation", "data"], "system.status query 응답");
    if (envelope.schemaVersion !== "massion.application.v1" || envelope.operation !== "system.status") {
      throw new Error("system.status query 계보가 일치하지 않습니다");
    }
    const data = observedExact(
      envelope.data,
      ["status", "mode", "database", "modelRuntime", "modelRuntimeDetails"],
      "system.status data",
    );
    if (data.status !== "ready" || data.mode !== "local" || !new Set(["limited", "ready"]).has(data.modelRuntime)) {
      throw new Error("Application status가 ready/local 상태가 아닙니다");
    }
    observedText(data.database, "system.status database", 128);
    const details = observedExact(data.modelRuntimeDetails, ["missingRoutes", "blockedRoutes"], "modelRuntimeDetails");
    observedStringArray(details.missingRoutes, "modelRuntime missingRoutes");
    observedStringArray(details.blockedRoutes, "modelRuntime blockedRoutes");
    facts = { mode: data.mode, modelRuntime: data.modelRuntime, status: data.status };
  } else if (kind === "subscription-providers") {
    facts = validateProviderCatalog(value, expected);
  } else if (kind === "subscription-accounts") {
    facts = validateAccountQuery(value, expected);
  } else if (kind === "subscription-doctor") {
    facts = validateDoctorQuery(value, expected);
  } else if (kind === "subscription-quota") {
    facts = validateQuotaQuery(value, expected);
  } else if (kind === "subscription-policy-command") {
    facts = validatePolicyCommand(value, expected);
  } else if (kind === "subscription-policy-query") {
    facts = validatePolicyQuery(value, expected);
  } else if (kind === "runtime-subscription-lineage") {
    facts = validateRuntimeSubscriptionLineageQuery(value, expected);
  } else if (kind === "application-run-terminal") {
    const terminal = observedExact(
      value,
      ["schemaVersion", "type", "status", "runId", "correlationId", "cursor"],
      "Application run terminal 응답",
    );
    if (
      terminal.schemaVersion !== "massion.cli.run.v1" ||
      terminal.type !== "result" ||
      terminal.status !== "completed"
    ) {
      throw new Error("Application run terminal 상태가 completed가 아닙니다");
    }
    facts = {
      correlationId: observedIdentifier(terminal.correlationId, "run correlationId"),
      cursor: observedInteger(terminal.cursor, "run terminal cursor", 0),
      runId: observedIdentifier(terminal.runId, "runId"),
      status: terminal.status,
    };
  } else if (kind === "server-restore") {
    const restored = observedExact(
      value,
      ["timestamp", "level", "event", "path", "checksum", "migrations"],
      "server restore 응답",
    );
    if (
      restored.level !== "info" ||
      restored.event !== "server.restore.completed" ||
      restored.path !== expected.path ||
      typeof restored.checksum !== "string" ||
      !/^[a-f0-9]{64}$/u.test(restored.checksum)
    ) {
      throw new Error("server restore 완료 계보가 일치하지 않습니다");
    }
    observedInstant(restored.timestamp, "server restore timestamp");
    facts = { event: restored.event, migrations: observedInteger(restored.migrations, "restore migrations", 0) };
  }
  if (facts === undefined) throw new Error("UAT 관찰 결과를 검증하지 못했습니다");
  return { kind, facts, digest: observationDigest(kind, facts) };
}

function validateAttempt(value, index) {
  const attempt = observedExact(
    value,
    [
      "attemptId",
      "sequence",
      "accountId",
      "credentialRef",
      "providerId",
      "modelId",
      "status",
      "failureSignal",
      "fallbackFrom",
      "leaseState",
    ],
    `attempt[${String(index)}]`,
  );
  if (attempt.status !== "failed" && attempt.status !== "succeeded")
    throw new Error("attempt status가 유효하지 않습니다");
  return {
    attemptId: observedIdentifier(attempt.attemptId, "attemptId"),
    sequence: observedInteger(attempt.sequence, "attempt sequence", 1),
    accountId: observedIdentifier(attempt.accountId, "attempt accountId"),
    credentialRef:
      typeof attempt.credentialRef === "string" && /^[a-f0-9]{64}$/u.test(attempt.credentialRef)
        ? attempt.credentialRef
        : (() => {
            throw new Error("attempt credential reference가 유효하지 않습니다");
          })(),
    providerId: observedIdentifier(attempt.providerId, "attempt providerId"),
    modelId: observedIdentifier(attempt.modelId, "attempt modelId"),
    status: attempt.status,
    ...(attempt.failureSignal === undefined
      ? {}
      : { failureSignal: observedText(attempt.failureSignal, "attempt failure signal", 64) }),
    ...(attempt.fallbackFrom === undefined
      ? {}
      : { fallbackFrom: observedIdentifier(attempt.fallbackFrom, "attempt fallbackFrom") }),
    ...(attempt.leaseState === undefined
      ? {}
      : { leaseState: observedText(attempt.leaseState, "attempt lease state", 32) }),
  };
}

function attemptLineage(value) {
  if (!Array.isArray(value) || value.length < 2) throw new Error("서로 다른 attempt 계보가 두 개 이상 필요합니다");
  const attempts = value.map(validateAttempt);
  if (new Set(attempts.map((attempt) => attempt.attemptId)).size !== attempts.length) {
    throw new Error("attemptId 계보가 중복됐습니다");
  }
  for (let index = 1; index < attempts.length; index += 1) {
    if (attempts[index].sequence <= attempts[index - 1].sequence)
      throw new Error("attempt sequence 계보가 증가하지 않습니다");
  }
  return attempts;
}

export function validateCredentialPolicyAttemptLineage(policy, value) {
  if (!new Set(["round-robin", "fill-first", "adaptive"]).has(policy)) {
    throw new Error("검증할 credential policy가 유효하지 않습니다");
  }
  const attempts = attemptLineage(value);
  if (policy === "fill-first") {
    if (
      attempts.length < 3 ||
      attempts[0].accountId !== attempts[1].accountId ||
      attempts[0].credentialRef !== attempts[1].credentialRef ||
      attempts[1].accountId === attempts[2].accountId ||
      attempts[1].credentialRef === attempts[2].credentialRef
    ) {
      throw new Error("fill-first는 같은 credential 선사용 후 서로 다른 credential attempt 계보가 필요합니다");
    }
  } else if (
    attempts[0].accountId === attempts[1].accountId ||
    attempts[0].credentialRef === attempts[1].credentialRef
  ) {
    throw new Error(`${policy}는 서로 다른(distinct) account·credential attempt 계보가 필요합니다`);
  }
  return { policy, attemptIds: attempts.map((attempt) => attempt.attemptId) };
}

export function validateFallbackAttemptLineage(signal, value) {
  if (!new Set(["offline", "rate-limit", "timeout"]).has(signal))
    throw new Error("fallback 실패 signal이 유효하지 않습니다");
  const attempts = attemptLineage(value);
  const failed = attempts[0];
  const fallback = attempts[1];
  if (failed.status !== "failed" || failed.failureSignal !== signal) {
    throw new Error("fallback 최초 실패 원인(signal)이 일치하지 않습니다");
  }
  if (fallback.status !== "succeeded" || fallback.fallbackFrom !== failed.attemptId) {
    throw new Error("fallbackFrom attempt 계보가 정확하지 않습니다");
  }
  for (const field of ["accountId", "credentialRef", "providerId", "modelId"]) {
    if (failed[field] === fallback[field]) throw new Error(`fallback ${field}는 서로 다른 계보여야 합니다`);
  }
  return { fallbackFrom: failed.attemptId, fallbackTo: fallback.attemptId, signal };
}

function publicFailureSignal(failureClass) {
  if (failureClass === undefined) return undefined;
  const value = observedText(failureClass, "attempt failure class", 32);
  if (
    !new Set([
      "authentication",
      "billing",
      "quota",
      "upstream",
      "timeout",
      "network",
      "input",
      "policy",
      "cancelled",
      "unknown",
    ]).has(value)
  ) {
    throw new Error("attempt failure class가 유효하지 않습니다");
  }
  if (value === "quota") return "rate-limit";
  if (value === "network") return "offline";
  return value;
}

function validatePublicTerminal(value, label) {
  if (value === undefined) return undefined;
  const terminal = observedExact(
    value,
    ["outcome", "inputTokens", "outputTokens", "emittedTokens", "sideEffectsStarted", "failure"],
    label,
  );
  if (!new Set(["completed", "failed", "cancelled", "interrupted"]).has(terminal.outcome)) {
    throw new Error(`${label} outcome이 유효하지 않습니다`);
  }
  for (const field of ["inputTokens", "outputTokens", "emittedTokens"]) {
    observedInteger(terminal[field], `${label} ${field}`, 0);
  }
  if (typeof terminal.sideEffectsStarted !== "boolean") throw new Error(`${label} side effect가 유효하지 않습니다`);
  if (terminal.failure !== undefined) {
    const failure = observedExact(terminal.failure, ["kind", "statusCode"], `${label} failure`);
    if (!new Set(["http", "timeout", "network", "input", "policy", "cancelled", "unknown"]).has(failure.kind)) {
      throw new Error(`${label} failure kind가 유효하지 않습니다`);
    }
    if (failure.kind === "http") {
      const status = observedInteger(failure.statusCode, `${label} HTTP status`, 100);
      if (status > 599) throw new Error(`${label} HTTP status가 유효하지 않습니다`);
    } else if (failure.statusCode !== undefined) {
      throw new Error(`${label} HTTP가 아닌 failure에 status가 있습니다`);
    }
  }
  if ((terminal.outcome === "completed") === (terminal.failure !== undefined)) {
    throw new Error(`${label} outcome과 failure가 일치하지 않습니다`);
  }
  return terminal;
}

function validatePublicAttempt(value, index) {
  const attempt = observedExact(
    value,
    [
      "attemptId",
      "sequence",
      "accountId",
      "credentialRef",
      "providerId",
      "modelId",
      "status",
      "fallbackFromAttemptId",
      "quotaSnapshotId",
      "routingPolicyVersion",
      "effectiveCredentialPolicy",
      "subscriptionPolicyVersion",
      "failureClass",
      "statusCode",
      "emittedTokens",
      "sideEffectsStarted",
      "fallbackAllowed",
      "lease",
      "approvalId",
      "terminal",
    ],
    `공개 attempt[${String(index)}]`,
  );
  if (!new Set(["reserved", "failed", "interrupted", "succeeded"]).has(attempt.status)) {
    throw new Error("공개 attempt status가 유효하지 않습니다");
  }
  if (typeof attempt.credentialRef !== "string" || !/^[a-f0-9]{64}$/u.test(attempt.credentialRef)) {
    throw new Error("공개 attempt credential reference가 유효하지 않습니다");
  }
  for (const field of ["routingPolicyVersion", "subscriptionPolicyVersion"]) {
    if (attempt[field] !== undefined) observedInteger(attempt[field], `공개 attempt ${field}`, 1);
  }
  if (attempt.quotaSnapshotId !== undefined) observedIdentifier(attempt.quotaSnapshotId, "quota snapshot ID");
  if (attempt.effectiveCredentialPolicy !== undefined) {
    observedIdentifier(attempt.effectiveCredentialPolicy, "effective credential policy");
  }
  if (attempt.statusCode !== undefined) {
    const status = observedInteger(attempt.statusCode, "attempt HTTP status", 100);
    if (status > 599) throw new Error("attempt HTTP status가 유효하지 않습니다");
  }
  observedInteger(attempt.emittedTokens, "attempt emitted tokens", 0);
  if (typeof attempt.sideEffectsStarted !== "boolean" || typeof attempt.fallbackAllowed !== "boolean") {
    throw new Error("공개 attempt boolean 상태가 유효하지 않습니다");
  }
  const lease = observedExact(attempt.lease, ["leaseId", "connectorId", "adapterId", "state"], "공개 lease");
  for (const [field, label] of [
    ["leaseId", "lease ID"],
    ["connectorId", "connector ID"],
    ["adapterId", "adapter ID"],
  ]) {
    observedIdentifier(lease[field], label);
  }
  if (!new Set(["acquired", "started", "checkpointed", "terminal", "settled"]).has(lease.state)) {
    throw new Error("공개 lease 상태가 유효하지 않습니다");
  }
  if (attempt.approvalId !== undefined) observedIdentifier(attempt.approvalId, "approval ID");
  const terminal = validatePublicTerminal(attempt.terminal, "공개 terminal");
  const normalized = validateAttempt(
    {
      attemptId: attempt.attemptId,
      sequence: attempt.sequence,
      accountId: attempt.accountId,
      credentialRef: attempt.credentialRef,
      providerId: attempt.providerId,
      modelId: attempt.modelId,
      status: attempt.status,
      ...(publicFailureSignal(attempt.failureClass) === undefined
        ? {}
        : { failureSignal: publicFailureSignal(attempt.failureClass) }),
      ...(attempt.fallbackFromAttemptId === undefined ? {} : { fallbackFrom: attempt.fallbackFromAttemptId }),
      leaseState: lease.state,
    },
    index,
  );
  return { normalized, terminal };
}

function validateRuntimeSubscriptionLineageQuery(value, expected) {
  const envelope = observedExact(value, ["schemaVersion", "operation", "data"], "Runtime 구독 계보 query 응답");
  if (
    envelope.schemaVersion !== "massion.application.v1" ||
    envelope.operation !== "runtime.execution.subscription-lineage"
  ) {
    throw new Error("Runtime 구독 계보 query 봉투가 유효하지 않습니다");
  }
  const data = observedExact(envelope.data, ["correlationId", "executions"], "Runtime 구독 계보 data");
  const correlationId = observedIdentifier(data.correlationId, "Runtime correlation ID");
  if (correlationId !== expected.correlationId || !Array.isArray(data.executions)) {
    throw new Error("Runtime correlation 계보가 일치하지 않습니다");
  }
  const seen = new Set();
  const detailed = data.executions.map((value, executionIndex) => {
    const execution = observedExact(
      value,
      ["executionId", "status", "attempts"],
      `Runtime lineage execution[${String(executionIndex)}]`,
    );
    const executionId = observedIdentifier(execution.executionId, "Runtime execution ID");
    if (seen.has(executionId)) throw new Error("Runtime execution ID 계보가 중복됐습니다");
    seen.add(executionId);
    if (
      !new Set([
        "queued",
        "running",
        "suspended",
        "succeeded",
        "failed",
        "cancelled",
        "interrupted",
        "blocked_model_unavailable",
      ]).has(execution.status) ||
      !Array.isArray(execution.attempts)
    ) {
      throw new Error("Runtime execution 상태 또는 attempt 목록이 유효하지 않습니다");
    }
    return {
      executionId,
      status: execution.status,
      attempts: execution.attempts.map(validatePublicAttempt),
    };
  });
  const attempts = detailed.flatMap((execution) => execution.attempts);
  if (expected.requireSettledSuccess === true) {
    const matched = attempts.filter(
      ({ normalized, terminal }) =>
        normalized.accountId === expected.accountId &&
        normalized.providerId === expected.providerId &&
        normalized.status === "succeeded" &&
        normalized.leaseState === "settled" &&
        terminal?.outcome === "completed",
    );
    if (matched.length < 1) throw new Error("정산 완료된 구독 실행 attempt 계보를 찾지 못했습니다");
  }
  return {
    correlationId,
    executions: detailed.map((execution) => ({
      executionId: execution.executionId,
      status: execution.status,
      attempts: execution.attempts.map((attempt) => attempt.normalized),
    })),
  };
}

function requiredOption(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} 값이 필요합니다`);
  return value;
}

export function parseSubscriptionUatArguments(argv) {
  if (argv[0] === "--validate") {
    if (argv.length !== 2 || !argv[1]) {
      throw new Error("사용법: node scripts/uat-subscriptions.mjs --validate <receipt.json>");
    }
    return { mode: "validate", path: resolve(argv[1]) };
  }
  if (argv[0] !== "--tmux") {
    throw new Error(
      "사용법: node scripts/uat-subscriptions.mjs --tmux --release <massion-local-VERSION.tar.gz> [--providers codex,claude,zai] [--interactive-provider-login] [--approved-providers claude,zai] [--timeout-ms N]",
    );
  }

  let release;
  let providers = ["codex", "claude", "zai"];
  let approvedProviders = [];
  let interactiveProviderLogin = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--release") {
      release = resolve(requiredOption(argv, index, argument));
      index += 1;
    } else if (argument === "--providers") {
      const value = requiredOption(argv, index, argument);
      providers = value.split(",");
      if (
        providers.length < 1 ||
        new Set(providers).size !== providers.length ||
        providers.some((provider) => !PROVIDER_NAMES.has(provider))
      ) {
        throw new Error("--providers는 중복 없는 codex,claude,zai 목록이어야 합니다");
      }
      index += 1;
    } else if (argument === "--interactive-provider-login") {
      interactiveProviderLogin = true;
    } else if (argument === "--approved-providers") {
      const value = requiredOption(argv, index, argument);
      approvedProviders = value.split(",");
      if (
        approvedProviders.length < 1 ||
        new Set(approvedProviders).size !== approvedProviders.length ||
        approvedProviders.some((provider) => provider !== "claude" && provider !== "zai")
      ) {
        throw new Error("--approved-providers는 중복 없는 claude,zai 목록이어야 합니다");
      }
      index += 1;
    } else if (argument === "--timeout-ms") {
      const value = requiredOption(argv, index, argument);
      if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("--timeout-ms가 유효하지 않습니다");
      timeoutMs = Number(value);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
        throw new Error(`--timeout-ms는 5000~${String(MAXIMUM_TIMEOUT_MS)} 범위여야 합니다`);
      }
      index += 1;
    } else {
      throw new Error(`지원하지 않는 UAT option입니다: ${String(argument)}`);
    }
  }
  if (!release) throw new Error("--release 최종 local archive가 필요합니다");
  if (!RELEASE_ARCHIVE.test(basename(release))) {
    throw new Error("--release는 massion-local-VERSION.tar.gz 최종 archive여야 합니다");
  }
  return { mode: "tmux", release, providers, approvedProviders, interactiveProviderLogin, timeoutMs };
}

export function validateReleaseBinding(input) {
  if (typeof input.gitStatus !== "string" || input.gitStatus.trim()) {
    throw new Error("Subscription UAT는 clean Git tree에서만 실행할 수 있습니다");
  }
  const manifest = input.manifest;
  const bundle = input.bundle;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.schema !== "massion.release.v1" ||
    typeof manifest.version !== "string" ||
    !SEMANTIC_VERSION.test(manifest.version) ||
    typeof manifest.gitCommit !== "string" ||
    !GIT_COMMIT.test(manifest.gitCommit) ||
    !SHA256.test(manifest.sourceDigest) ||
    !manifest.toolchains ||
    ![manifest.toolchains.node, manifest.toolchains.bun, manifest.toolchains.pnpm].every((value) =>
      SEMANTIC_VERSION.test(value),
    ) ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error("release manifest가 유효하지 않습니다");
  }
  const versionMatch = RELEASE_ARCHIVE.exec(input.archiveName);
  if (!versionMatch || versionMatch[1] !== manifest.version)
    throw new Error("release archive version이 일치하지 않습니다");
  if (input.currentCommit !== manifest.gitCommit) throw new Error("release와 현재 Git commit이 일치하지 않습니다");
  if (input.currentSourceDigest !== manifest.sourceDigest) {
    throw new Error("release manifest와 현재 Git source digest가 일치하지 않습니다");
  }
  if (!SHA256.test(input.archiveDigest)) throw new Error("release archive digest가 유효하지 않습니다");
  if (!Number.isSafeInteger(input.archiveBytes) || input.archiveBytes < 1) {
    throw new Error("release archive byte 크기가 유효하지 않습니다");
  }
  const artifact = manifest.artifacts.find((candidate) => candidate?.name === input.archiveName);
  if (!artifact || artifact.bytes !== input.archiveBytes || artifact.digest !== input.archiveDigest) {
    throw new Error("release archive bytes 또는 digest가 manifest와 일치하지 않습니다");
  }
  if (
    !bundle ||
    typeof bundle !== "object" ||
    bundle.schema !== "massion.release-bundle.v1" ||
    bundle.version !== manifest.version ||
    bundle.gitCommit !== manifest.gitCommit ||
    !bundle.entrypoints ||
    typeof bundle.entrypoints !== "object"
  ) {
    throw new Error("release bundle과 manifest의 commit·version 계보가 일치하지 않습니다");
  }
  if (bundle.sourceDigest !== manifest.sourceDigest) {
    throw new Error("release bundle과 manifest의 source digest가 일치하지 않습니다");
  }
  for (const [name, path] of Object.entries(REQUIRED_ENTRYPOINTS)) {
    if (bundle.entrypoints[name] !== path) throw new Error(`release bundle entrypoint가 유효하지 않습니다: ${name}`);
  }
  return { gitCommit: manifest.gitCommit, releaseDigest: input.archiveDigest, version: manifest.version };
}

async function ownerOnlyDirectory(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    metadata = await lstat(path);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("UAT directory는 owner-only 일반 directory여야 합니다");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("UAT directory는 현재 사용자 소유여야 합니다");
  }
  await chmod(path, 0o700);
  return await realpath(path);
}

export async function createUatWorkspace(parent = tmpdir()) {
  const safeParent = resolve(parent);
  await mkdir(safeParent, { recursive: true });
  const root = await ownerOnlyDirectory(await mkdtemp(join(safeParent, "massion-uat-phase24-")));
  const paths = {
    root,
    home: join(root, "home"),
    prefix: join(root, "prefix"),
    configHome: join(root, "xdg-config"),
    dataHome: join(root, "xdg-data"),
    stateHome: join(root, "xdg-state"),
    temporaryDirectory: join(root, "tmp"),
    extractedDirectory: join(root, "release"),
    restoreDirectory: join(root, "restore"),
  };
  for (const path of Object.values(paths).slice(1)) await ownerOnlyDirectory(path);
  return paths;
}

function tmuxEnvironment(environment = {}) {
  const inherited = {};
  for (const key of ["LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return { ...inherited, ...environment };
}

function tmux(socketName, arguments_, options = {}) {
  const result = spawnSync("tmux", ["-L", socketName, ...arguments_], {
    encoding: "utf8",
    env: tmuxEnvironment(options.environment),
    maxBuffer: 64 * 1024,
    timeout: options.timeoutMs ?? 10_000,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`tmux ${arguments_[0] ?? "command"} 실행이 실패했습니다`);
  }
  return result;
}

function validTmuxIdentity(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{1,127}$/u.test(value)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return value;
}

export async function destroyTmuxUatSession(input) {
  const socketName = validTmuxIdentity(input.socketName, "tmux socket name");
  const sessionName = validTmuxIdentity(input.sessionName, "tmux session name");
  tmux(socketName, ["kill-session", "-t", `=${sessionName}`], {
    allowFailure: true,
    environment: input.environment,
  });
  tmux(socketName, ["kill-server"], { allowFailure: true, environment: input.environment });
}

export async function createTmuxUatSession(input) {
  const socketName = validTmuxIdentity(input.socketName, "tmux socket name");
  const sessionName = validTmuxIdentity(input.sessionName, "tmux session name");
  const shell = resolve(input.shell || process.env.SHELL || "/bin/sh");
  if (!isAbsolute(shell) || /[\0\r\n]/u.test(shell)) throw new Error("tmux shell이 유효하지 않습니다");
  await destroyTmuxUatSession({ socketName, sessionName, environment: input.environment });
  tmux(socketName, ["-f", "/dev/null", "new-session", "-d", "-s", sessionName, "-n", "daemon", shell], {
    environment: input.environment,
  });
  for (const name of TMUX_WINDOWS.slice(1)) {
    tmux(socketName, ["new-window", "-d", "-t", `=${sessionName}`, "-n", name, shell], {
      environment: input.environment,
    });
  }
  tmux(socketName, ["set-option", "-g", "-t", `=${sessionName}`, "history-limit", "0"], {
    environment: input.environment,
  });
  tmux(socketName, ["set-option", "-g", "-t", `=${sessionName}`, "allow-rename", "off"], {
    environment: input.environment,
  });
  tmux(socketName, ["set-option", "-g", "-t", `=${sessionName}`, "remain-on-exit", "on"], {
    environment: input.environment,
  });
  const windows = String(
    tmux(socketName, ["list-windows", "-t", `=${sessionName}`, "-F", "#{window_name}"], {
      environment: input.environment,
    }).stdout,
  )
    .trim()
    .split("\n");
  if (JSON.stringify(windows) !== JSON.stringify(TMUX_WINDOWS)) {
    await destroyTmuxUatSession({ socketName, sessionName, environment: input.environment });
    throw new Error("tmux UAT window 구성이 유효하지 않습니다");
  }
  return { socketName, sessionName, shell, windows, environment: input.environment };
}

function shellQuote(value) {
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) throw new Error("UAT command 인수가 유효하지 않습니다");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellCommand(input) {
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || !isAbsolute(input.cwd))) {
    throw new Error("UAT command working directory가 절대 경로가 아닙니다");
  }
  const environment = Object.entries(input.environment ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof value !== "string") {
        throw new Error("UAT command environment가 유효하지 않습니다");
      }
      return `${key}=${shellQuote(value)}`;
    });
  const command = [shellQuote(input.command), ...(input.arguments ?? []).map(shellQuote)];
  const invocation = environment.length > 0 ? ["env", ...environment, ...command] : command;
  const prefix = input.cwd === undefined ? "exec " : `cd ${shellQuote(input.cwd)} && exec `;
  return `${prefix}${invocation.join(" ")}${input.interactive ? "" : " >/dev/null 2>&1"}`;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function paneState(session, window) {
  const result = tmux(
    session.socketName,
    ["display-message", "-p", "-t", `=${session.sessionName}:${window}`, "#{pane_dead}:#{pane_dead_status}"],
    { environment: session.environment },
  );
  const match = /^(0|1):([0-9]*)$/u.exec(String(result.stdout).trim());
  if (!match) throw new Error("tmux pane 상태가 유효하지 않습니다");
  return { dead: match[1] === "1", exitCode: match[2] === "" ? undefined : Number(match[2]) };
}

function respawnShell(session, window) {
  tmux(session.socketName, ["respawn-window", "-k", "-t", `=${session.sessionName}:${window}`, session.shell], {
    environment: session.environment,
  });
}

export async function runTmuxUatCommand(session, input) {
  if (!session.windows.includes(input.window)) throw new Error("UAT command window가 유효하지 않습니다");
  const step = safeName(input.step, "UAT command step");
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error("UAT command timeout이 유효하지 않습니다");
  }
  if (input.signal?.aborted) return { step, exitCode: 130 };
  tmux(
    session.socketName,
    ["respawn-window", "-k", "-t", `=${session.sessionName}:${input.window}`, shellCommand(input)],
    { environment: session.environment },
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (input.signal?.aborted) {
      tmux(session.socketName, ["send-keys", "-t", `=${session.sessionName}:${input.window}`, "C-c"], {
        allowFailure: true,
        environment: session.environment,
      });
      await wait(250);
      respawnShell(session, input.window);
      return { step, exitCode: 130 };
    }
    const state = paneState(session, input.window);
    if (state.dead) {
      const exitCode =
        Number.isInteger(state.exitCode) && state.exitCode >= 0 && state.exitCode <= 255 ? state.exitCode : 255;
      respawnShell(session, input.window);
      return { step, exitCode };
    }
    await wait(50);
  }
  tmux(session.socketName, ["send-keys", "-t", `=${session.sessionName}:${input.window}`, "C-c"], {
    allowFailure: true,
    environment: session.environment,
  });
  await wait(250);
  respawnShell(session, input.window);
  return { step, exitCode: 124 };
}

async function writeInternalObservation(path, value) {
  const temporaryDirectory = process.env.TMPDIR;
  if (!temporaryDirectory || !isAbsolute(temporaryDirectory)) throw new Error("UAT TMPDIR 절대 경로가 필요합니다");
  const temporaryRoot = await ownerOnlyDirectory(temporaryDirectory);
  const target = resolve(path);
  if (dirname(target) !== temporaryRoot || !/^\.massion-uat-observation-[a-f0-9]{32}\.json$/u.test(basename(target))) {
    throw new Error("UAT 관찰 전달 경로가 격리 root 밖입니다");
  }
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function runInternalObserver(encoded) {
  let specification;
  try {
    const decoded = Buffer.from(observedText(encoded, "내부 관찰 사양", 256 * 1024), "base64url").toString("utf8");
    specification = observedExact(
      JSON.parse(decoded),
      ["schema", "kind", "expected", "command", "arguments", "observationPath", "cwd"],
      "내부 관찰 사양",
    );
  } catch {
    return 65;
  }
  if (
    specification.schema !== OBSERVATION_SCHEMA ||
    !OBSERVATION_KINDS.has(specification.kind) ||
    typeof specification.command !== "string" ||
    !isAbsolute(specification.command) ||
    !Array.isArray(specification.arguments) ||
    specification.arguments.length > 256 ||
    specification.arguments.some(
      (argument) => typeof argument !== "string" || argument.length > 64 * 1024 || /[\0\r\n]/u.test(argument),
    ) ||
    typeof specification.observationPath !== "string" ||
    (specification.cwd !== undefined &&
      (typeof specification.cwd !== "string" || !isAbsolute(specification.cwd) || /[\0\r\n]/u.test(specification.cwd)))
  ) {
    return 65;
  }
  const result = spawnSync(specification.command, specification.arguments, {
    encoding: "utf8",
    env: process.env,
    cwd: specification.cwd,
    maxBuffer: MAXIMUM_OBSERVED_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return Number.isInteger(result.status) && result.status >= 1 && result.status <= 255 ? result.status : 70;
  }
  const output = String(result.stdout);
  if (specification.kind !== "exact-text") {
    try {
      JSON.parse(output.trim());
    } catch {
      // 원문을 보존하지 않고 JSON 형식 오류만 구분합니다.
      return 66;
    }
  }
  let observation;
  try {
    observation = parseAndValidateObservedUatOutput(specification.kind, output, specification.expected);
  } catch {
    // 유효 JSON이지만 공개 UAT 계약을 만족하지 않는 경우입니다.
    return 67;
  }
  try {
    await writeInternalObservation(specification.observationPath, observation);
  } catch {
    // owner-only 관찰 결과를 안전하게 전달하지 못한 경우입니다.
    return 68;
  }
  return 0;
}

export async function runTmuxObservedCommand(session, input) {
  const kind = input.observation?.kind;
  if (!OBSERVATION_KINDS.has(kind)) throw new Error("UAT JSON 관찰 종류가 유효하지 않습니다");
  const temporaryDirectory = input.environment?.TMPDIR;
  if (!temporaryDirectory || !isAbsolute(temporaryDirectory)) throw new Error("UAT TMPDIR 절대 경로가 필요합니다");
  const temporaryRoot = await ownerOnlyDirectory(temporaryDirectory);
  const observationPath = join(temporaryRoot, `.massion-uat-observation-${randomBytes(16).toString("hex")}.json`);
  const specification = Buffer.from(
    JSON.stringify({
      schema: OBSERVATION_SCHEMA,
      kind,
      expected: input.observation.expected ?? {},
      command: input.command,
      arguments: input.arguments ?? [],
      observationPath,
      cwd: input.cwd,
    }),
  ).toString("base64url");
  let commandResult;
  try {
    commandResult = await runTmuxUatCommand(session, {
      window: input.window,
      step: input.step,
      command: process.execPath,
      arguments: [fileURLToPath(import.meta.url), "--internal-observe", specification],
      environment: input.environment,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    if (commandResult.exitCode !== 0) return { command: commandResult, observation: undefined };
    const metadata = await lstat(observationPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
      metadata.size < 1 ||
      metadata.size > 64 * 1024
    ) {
      throw new Error("UAT 관찰 전달 파일이 유효하지 않습니다");
    }
    const observation = observedExact(
      JSON.parse(await readFile(observationPath, "utf8")),
      ["kind", "facts", "digest"],
      "UAT 관찰 결과",
    );
    if (
      observation.kind !== kind ||
      !SHA256.test(observation.digest) ||
      observation.digest !== observationDigest(observation.kind, observedObject(observation.facts, "UAT 관찰 facts"))
    ) {
      throw new Error("UAT 관찰 결과 digest 계보가 일치하지 않습니다");
    }
    return { command: commandResult, observation };
  } catch {
    return {
      command: { step: safeName(input.step, "UAT command step"), exitCode: commandResult?.exitCode || 65 },
      observation: undefined,
    };
  } finally {
    await rm(observationPath, { force: true });
  }
}

async function startTmuxBackgroundCommand(session, input) {
  if (!session.windows.includes(input.window)) throw new Error("UAT background window가 유효하지 않습니다");
  if (input.signal?.aborted) return { step: safeName(input.step, "UAT background step"), exitCode: 130 };
  tmux(
    session.socketName,
    ["respawn-window", "-k", "-t", `=${session.sessionName}:${input.window}`, shellCommand(input)],
    { environment: session.environment },
  );
  await wait(100);
  if (paneState(session, input.window).dead) {
    const code = paneState(session, input.window).exitCode ?? 255;
    respawnShell(session, input.window);
    return { step: safeName(input.step, "UAT background step"), exitCode: code };
  }
  return { step: safeName(input.step, "UAT background step"), exitCode: 0 };
}

async function stopTmuxBackgroundCommand(session, window) {
  tmux(session.socketName, ["send-keys", "-t", `=${session.sessionName}:${window}`, "C-c"], {
    allowFailure: true,
    environment: session.environment,
  });
  await wait(250);
  respawnShell(session, window);
}

export function planProviderScenarios(providers, interactiveProviderLogin, approvedProviders = []) {
  const approved = new Set(approvedProviders);
  return providers.map((provider) => {
    if (!PROVIDER_NAMES.has(provider)) throw new Error(`지원하지 않는 UAT provider입니다: ${provider}`);
    if (provider === "codex") {
      return {
        id: "codex-live-subscription",
        provider: "openai-codex",
        ...(interactiveProviderLogin ? {} : { prerequisite: "interactive-login-required" }),
      };
    }
    if (provider === "claude") {
      return {
        id: "claude-live-subscription",
        provider: "anthropic-claude-code",
        prerequisite: approved.has("claude") ? "public-provider-connect-unavailable" : "provider-approval-required",
      };
    }
    return {
      id: "zai-live-subscription",
      provider: "zai-coding-plan",
      prerequisite: approved.has("zai") ? "public-provider-connect-unavailable" : "provider-approval-required",
    };
  });
}

export function planUnsupportedLineageScenarios() {
  return [
    { id: "round-robin-attempt-lineage", prerequisite: "second-account-required" },
    { id: "fill-first-attempt-lineage", prerequisite: "second-account-required" },
    { id: "adaptive-attempt-lineage", prerequisite: "second-account-required" },
    { id: "share-unshare-lease-lineage", prerequisite: "second-user-required" },
    { id: "offline-fallback-lineage", prerequisite: "public-failure-injection-unavailable" },
    { id: "rate-limit-fallback-lineage", prerequisite: "public-failure-injection-unavailable" },
    { id: "timeout-fallback-lineage", prerequisite: "public-failure-injection-unavailable" },
    { id: "suspend-resume-terminal-lineage", prerequisite: "approval-checkpoint-required" },
  ];
}

export async function atomicWriteSubscriptionUatReceipt(path, value) {
  const receipt = validateSubscriptionUatReceipt(value);
  const requestedTarget = resolve(path);
  const directory = await ownerOnlyDirectory(dirname(requestedTarget));
  const target = join(directory, basename(requestedTarget));
  try {
    const current = await lstat(target);
    if (!current.isFile() || current.isSymbolicLink() || (current.mode & 0o077) !== 0) {
      throw new Error("기존 UAT receipt는 owner-only 일반 파일이어야 합니다");
    }
    if (typeof process.getuid === "function" && current.uid !== process.getuid()) {
      throw new Error("기존 UAT receipt는 현재 사용자 소유여야 합니다");
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const temporary = join(directory, `.receipt-${String(process.pid)}-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, undefined, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await chmod(target, 0o600);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return receipt;
}

export async function rebindUatCliEndpoint(configPath, endpointValue) {
  const target = resolve(configPath);
  const metadata = await lstat(target);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    metadata.size < 1 ||
    metadata.size > 64 * 1024
  ) {
    throw new Error("UAT CLI config는 현재 사용자 소유의 0600 일반 파일이어야 합니다");
  }
  const endpoint = new URL(endpointValue);
  if (
    endpoint.protocol !== "http:" ||
    !new Set(["127.0.0.1", "[::1]", "localhost"]).has(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("UAT 복구 endpoint는 자격 증명이 없는 local loopback HTTP여야 합니다");
  }
  const config = observedExact(
    JSON.parse(await readFile(target, "utf8")),
    ["schemaVersion", "selectedProfile", "profiles"],
    "UAT CLI config",
  );
  if (config.schemaVersion !== "massion.cli.config.v1") throw new Error("UAT CLI config schema가 유효하지 않습니다");
  const selectedProfile = observedIdentifier(config.selectedProfile, "UAT CLI selected profile");
  const profiles = observedObject(config.profiles, "UAT CLI profiles");
  const selected = observedExact(profiles[selectedProfile], ["endpoint", "tokenReference"], "UAT CLI profile");
  observedText(selected.tokenReference, "UAT CLI token reference", 4096);
  const rebound = {
    schemaVersion: "massion.cli.config.v1",
    selectedProfile,
    profiles: {
      ...profiles,
      [selectedProfile]: {
        endpoint: endpoint.toString().replace(/\/$/u, ""),
        tokenReference: selected.tokenReference,
      },
    },
  };
  const temporary = join(dirname(target), `.config-rebind-${String(process.pid)}-${randomBytes(8).toString("hex")}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(rebound, undefined, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function runCaptured(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.environment ?? process.env,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30_000,
  });
  if (result.status !== 0) throw new Error(`${options.label ?? command} 실행이 실패했습니다`);
  return String(result.stdout);
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function gitSourceDigest(root) {
  const files = runCaptured("git", ["ls-files", "-z"], { cwd: root, label: "Git source 목록 확인" })
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(resolve(root, file)))
      .update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function safeArchiveEntry(value) {
  if (typeof value !== "string" || /[\0\r\\]/u.test(value) || value.startsWith("/")) return false;
  const normalized = value.replace(/^\.\//u, "");
  return normalized === "" || normalized === "." || !normalized.split("/").includes("..");
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function verifyExtractedLinks(root, current = root) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || !within(root, resolve(dirname(path), target))) {
        throw new Error("release archive symbolic link가 격리 경계를 벗어납니다");
      }
    } else if (metadata.isDirectory()) {
      await verifyExtractedLinks(root, path);
    }
  }
}

async function inspectReleaseArchive(archivePath, workspace, repositoryRoot) {
  const archive = resolve(archivePath);
  const manifest = JSON.parse(await readFile(join(dirname(archive), "release-manifest.json"), "utf8"));
  const metadata = await stat(archive);
  const archiveDigest = await fileDigest(archive);
  const archiveName = basename(archive);
  const currentCommit = runCaptured("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    label: "Git commit 확인",
  }).trim();
  const gitStatus = runCaptured("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: repositoryRoot,
    label: "Git clean tree 확인",
  });
  if (gitStatus.trim()) throw new Error("Subscription UAT는 clean Git tree에서만 실행할 수 있습니다");
  if (manifest?.gitCommit !== currentCommit) throw new Error("release와 현재 Git commit이 일치하지 않습니다");
  const currentSourceDigest = await gitSourceDigest(repositoryRoot);
  const artifact = Array.isArray(manifest?.artifacts)
    ? manifest.artifacts.find((candidate) => candidate?.name === archiveName)
    : undefined;
  if (artifact?.bytes !== metadata.size || artifact?.digest !== archiveDigest) {
    throw new Error("release archive bytes 또는 digest가 manifest와 일치하지 않습니다");
  }
  const listing = runCaptured("tar", ["-tzf", archive], { label: "release archive 목록 확인" });
  const entries = listing.split("\n").filter(Boolean);
  if (entries.length < 1 || entries.length > 200_000 || entries.some((entry) => !safeArchiveEntry(entry))) {
    throw new Error("release archive 경로가 안전하지 않습니다");
  }
  runCaptured("tar", ["-xzf", archive, "-C", workspace.extractedDirectory, "--no-same-owner"], {
    label: "release archive 압축 해제",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  await verifyExtractedLinks(workspace.extractedDirectory);
  const bundle = JSON.parse(await readFile(join(workspace.extractedDirectory, "release-bundle.json"), "utf8"));
  const identity = validateReleaseBinding({
    archiveName,
    archiveBytes: metadata.size,
    archiveDigest,
    manifest,
    bundle,
    currentCommit,
    currentSourceDigest,
    gitStatus,
  });
  const installer = join(workspace.extractedDirectory, "install.sh");
  const installerMetadata = await lstat(installer);
  if (!installerMetadata.isFile() || installerMetadata.isSymbolicLink()) {
    throw new Error("release install.sh가 안전한 일반 파일이 아닙니다");
  }
  return { ...identity, installer };
}

async function availablePort(port) {
  return await new Promise((resolveAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveAvailable(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

async function allocatePortBase() {
  const start = 20_000 + (Number.parseInt(randomBytes(2).toString("hex"), 16) % 20_000);
  for (let offset = 0; offset < 5_000; offset += 17) {
    const candidate = start + offset;
    if (candidate + 12 > 65_535) continue;
    const ports = [candidate, candidate + 1, candidate + 2, candidate + 10, candidate + 11, candidate + 12];
    if ((await Promise.all(ports.map(availablePort))).every(Boolean)) return candidate;
  }
  throw new Error("UAT용 loopback port 범위를 찾지 못했습니다");
}

function scenarioNotRun(plan, now) {
  return {
    id: plan.id,
    provider: plan.provider ?? "massion-subscriptions",
    status: "not-run",
    startedAt: now,
    endedAt: now,
    assertions: [],
    commands: [],
    lineage: [],
    prerequisite: plan.prerequisite,
  };
}

export function classifyUatFailure(step, code) {
  if (code === 124) return "network";
  if (code === 130) return "cancelled";
  if (code === 65 || code === 70) return "product";
  if (step.includes("quota")) return "quota";
  if (step.includes("connect")) {
    if (code === 2 || code === 3 || code === 4) return "authentication";
    if (code === 7) return "provider";
    return "product";
  }
  if (step.includes("run") || step.includes("doctor")) return "provider";
  return "product";
}

export function validateOperationalLogText(value, ownerIdentity) {
  if (typeof value !== "string" || typeof ownerIdentity !== "string" || ownerIdentity.length < 1) {
    throw new Error("UAT operational log 검증 입력이 유효하지 않습니다");
  }
  if (value.includes(ownerIdentity) || FORBIDDEN_STRING.some((pattern) => pattern.test(value))) {
    throw new Error("UAT operational log에 비밀·개인정보·로컬 경로가 있습니다");
  }
  return true;
}

export async function verifyOperationalLogFile(path, ownerIdentity) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 1 ||
    metadata.size > 16 * 1024 * 1024 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("UAT operational log가 owner-only 일반 파일이 아닙니다");
  }
  validateOperationalLogText(await readFile(path, "utf8"), ownerIdentity);
  return true;
}

async function executeProviderScenario(session, plan, environment, timeoutMs, releaseDigest, signal) {
  const startedAt = new Date().toISOString();
  const commands = [];
  const assertions = [];
  const lineage = [releaseDigest];
  const supplemental = [];
  const mass = join(environment.MASSION_PREFIX, "bin", "mass");
  const alias = `UAT ${plan.provider}`;
  const policy = subscriptionUatPolicy(plan.provider);
  const runPlan = subscriptionUatRunPlan(randomUUID());
  const connect = await runTmuxUatCommand(session, {
    window: "connectors",
    step: `${plan.id}-connect`,
    command: mass,
    arguments: ["subscription", "connect", plan.provider, alias],
    environment,
    timeoutMs,
    interactive: true,
    signal,
  });
  commands.push(connect);
  const observe = async (input) => {
    if (commands.some((command) => command.exitCode !== 0)) return undefined;
    const result = await runTmuxObservedCommand(session, {
      window: input.window ?? "connectors",
      step: input.step,
      command: mass,
      arguments: input.arguments,
      environment,
      timeoutMs,
      signal,
      observation: input.observation,
    });
    commands.push(result.command);
    if (result.observation) lineage.push(result.observation.digest);
    return result.observation;
  };

  const accountObservation = await observe({
    step: `${plan.id}-accounts`,
    arguments: ["subscription", "accounts", "--json"],
    observation: { kind: "subscription-accounts", expected: { providerId: plan.provider, alias } },
  });
  if (accountObservation) assertions.push("account-query-verified");
  const account = accountObservation?.facts;
  const doctorObservation = account
    ? await observe({
        step: `${plan.id}-doctor`,
        arguments: ["subscription", "doctor", account.accountId, "--json"],
        observation: {
          kind: "subscription-doctor",
          expected: {
            providerId: plan.provider,
            accountId: account.accountId,
            connectorId: account.connectorId,
          },
        },
      })
    : undefined;
  if (doctorObservation) assertions.push("provider-health-verified");
  const quotaObservation = account
    ? await observe({
        step: `${plan.id}-quota`,
        arguments: ["subscription", "quota", account.accountId, "--json"],
        observation: { kind: "subscription-quota", expected: { accountId: account.accountId } },
      })
    : undefined;
  if (quotaObservation?.facts.available === true) {
    assertions.push("quota-query-verified");
  } else if (quotaObservation) {
    const now = new Date().toISOString();
    supplemental.push(
      scenarioNotRun(
        {
          id: `${plan.id}-quota-contract`,
          provider: plan.provider,
          prerequisite: "missing-quota-contract",
        },
        now,
      ),
    );
  }
  const policyCommand = await observe({
    step: `${plan.id}-policy-configure`,
    arguments: ["subscription", "policy", plan.provider, policy.credentialPolicy, policy.approvalMode, "--json"],
    observation: {
      kind: "subscription-policy-command",
      expected: policy,
    },
  });
  const policyQuery = policyCommand
    ? await observe({
        step: `${plan.id}-policy-query`,
        arguments: ["subscription", "policy", plan.provider, "--json"],
        observation: {
          kind: "subscription-policy-query",
          expected: {
            ...policy,
            version: policyCommand.facts.version,
          },
        },
      })
    : undefined;
  if (policyQuery) assertions.push("adaptive-policy-verified");
  const terminal = await observe({
    window: "user",
    step: `${plan.id}-run`,
    arguments: runPlan.runArguments,
    observation: { kind: "application-run-terminal", expected: {} },
  });
  if (terminal) assertions.push("application-run-terminal");
  const runtimeLineage = account
    ? await runTmuxObservedCommand(session, {
        window: "user",
        step: `${plan.id}-runtime-lineage`,
        command: mass,
        arguments: runPlan.lineageArguments,
        environment,
        timeoutMs,
        signal,
        observation: {
          kind: "runtime-subscription-lineage",
          expected: {
            correlationId: runPlan.correlationId,
            accountId: account.accountId,
            providerId: plan.provider,
            ...(terminal ? { requireSettledSuccess: true } : {}),
          },
        },
      })
    : undefined;
  if (runtimeLineage) {
    commands.push(runtimeLineage.command);
    if (runtimeLineage.observation) {
      lineage.push(runtimeLineage.observation.digest);
      assertions.push(terminal ? "subscription-lineage-verified" : "timeout-lineage-observed");
    }
  }
  const failure = commands.find((command) => command.exitCode !== 0);
  return {
    scenario: {
      id: plan.id,
      provider: plan.provider,
      status: failure ? "failed" : "passed",
      startedAt,
      endedAt: new Date().toISOString(),
      assertions,
      commands,
      lineage: [...new Set(lineage)],
      ...(failure ? { failureClass: classifyUatFailure(failure.step, failure.exitCode) } : {}),
    },
    supplemental,
    account: accountObservation ? account : undefined,
    correlationId: runPlan.correlationId,
    attemptIds:
      runtimeLineage?.observation?.facts.executions.flatMap((execution) =>
        execution.attempts.map((attempt) => attempt.attemptId),
      ) ?? [],
  };
}

export async function runSubscriptionUat(options) {
  const repositoryRoot = resolve(options.repositoryRoot);
  const receiptPath = resolve(repositoryRoot, "artifacts/uat-phase-24/receipt.json");
  const sessionName = "massion-uat-phase24";
  const socketName = "massion-uat-phase24";
  await destroyTmuxUatSession({ socketName, sessionName });
  const workspace = await createUatWorkspace();
  const startedAt = new Date().toISOString();
  let session;
  let environment;
  let identity;
  const commands = [];
  const assertions = [];
  const lifecycleLineage = [];
  const providerEvidence = new Map();
  const providerPlans = planProviderScenarios(
    options.providers,
    options.interactiveProviderLogin,
    options.approvedProviders ?? [],
  );
  const providerScenarios = [
    ...providerPlans.filter((plan) => plan.prerequisite).map((plan) => scenarioNotRun(plan, startedAt)),
    ...planUnsupportedLineageScenarios().map((plan) => scenarioNotRun(plan, startedAt)),
  ];
  let lifecycleFailure;
  let ownerIdentity;
  try {
    identity = await inspectReleaseArchive(options.release, workspace, repositoryRoot);
    const port = await allocatePortBase();
    const path = `${join(workspace.prefix, "bin")}:${process.env.PATH ?? ""}`;
    environment = {
      HOME: workspace.home,
      XDG_CONFIG_HOME: workspace.configHome,
      XDG_DATA_HOME: workspace.dataHome,
      XDG_STATE_HOME: workspace.stateHome,
      TMPDIR: workspace.temporaryDirectory,
      MASSION_PREFIX: workspace.prefix,
      MASSION_LOCAL_PORT: String(port),
      PATH: path,
      NO_COLOR: "1",
    };
    session = await createTmuxUatSession({
      socketName,
      sessionName,
      shell: "/bin/sh",
      environment,
    });
    const mass = join(workspace.prefix, "bin", "mass");
    const connector = join(workspace.prefix, "bin", "massion-connector");
    const server = join(workspace.prefix, "bin", "massion-server");
    const endpoint = `http://127.0.0.1:${String(port)}`;
    const required = async (input) => {
      const result = await runTmuxUatCommand(session, {
        environment,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        ...input,
      });
      commands.push(result);
      if (result.exitCode !== 0) {
        const error = new Error(`UAT 필수 단계가 실패했습니다: ${result.step}`);
        error.step = result.step;
        error.exitCode = result.exitCode;
        throw error;
      }
      return result;
    };
    const requiredObserved = async (input) => {
      const result = await runTmuxObservedCommand(session, {
        environment,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        ...input,
      });
      commands.push(result.command);
      if (result.command.exitCode !== 0 || !result.observation) {
        const error = new Error(`UAT JSON 검증 단계가 실패했습니다: ${result.command.step}`);
        error.step = result.command.step;
        error.exitCode = result.command.exitCode || 65;
        throw error;
      }
      lifecycleLineage.push(result.observation.digest);
      return result.observation;
    };
    await required({ window: "daemon", step: "install-release", command: "/bin/sh", arguments: [identity.installer] });
    assertions.push("release-installed");
    await requiredObserved({
      window: "daemon",
      step: "version-check",
      command: mass,
      arguments: ["version"],
      observation: { kind: "exact-text", expected: { value: `Massion AgentOS ${identity.version}` } },
    });
    await requiredObserved({
      window: "connectors",
      step: "connector-doctor",
      command: connector,
      arguments: ["doctor"],
      observation: { kind: "connector-doctor", expected: {} },
    });
    assertions.push("version-output-verified", "connector-doctor-verified");
    await requiredObserved({
      window: "daemon",
      step: "local-start",
      command: mass,
      arguments: ["local", "start", "--json"],
      observation: { kind: "local-start", expected: { endpoint, status: "started" } },
    });
    ownerIdentity = `uat-owner${String.fromCharCode(64)}invalid.example`;
    await requiredObserved({
      window: "user",
      step: "initialize-owner",
      command: mass,
      arguments: ["init", endpoint, ownerIdentity, "UAT Owner", "--json"],
      observation: { kind: "initialize-owner", expected: { endpoint, profile: "local" } },
    });
    await requiredObserved({
      window: "user",
      step: "status-ready",
      command: mass,
      arguments: ["status", "--json"],
      observation: { kind: "application-status", expected: {} },
    });
    await required({
      window: "user",
      step: "readiness-probe",
      command: process.execPath,
      arguments: [
        "-e",
        "const r=await fetch(process.argv[1]+'/health/ready');const b=await r.json();if(!r.ok||b.status!=='ready')process.exit(1)",
        endpoint,
      ],
    });
    assertions.push("daemon-ready", "owner-initialized", "application-status-verified");
    const providerCatalogExpectations = {
      codex: { providerId: "openai-codex", availability: "supported" },
      claude: { providerId: "anthropic-claude-code", availability: "requires-provider-approval" },
      zai: { providerId: "zai-coding-plan", availability: "requires-provider-approval" },
    };
    await requiredObserved({
      window: "connectors",
      step: "subscription-catalog",
      command: mass,
      arguments: ["subscription", "providers", "--json"],
      observation: {
        kind: "subscription-providers",
        expected: { providers: options.providers.map((provider) => providerCatalogExpectations[provider]) },
      },
    });
    assertions.push("subscription-catalog-verified");
    const watch = await startTmuxBackgroundCommand(session, {
      window: "watch",
      step: "event-watch",
      command: mass,
      arguments: ["watch", "--events", "jsonl"],
      environment,
      signal: options.signal,
    });
    commands.push(watch);
    if (watch.exitCode !== 0) throw Object.assign(new Error("UAT event watch가 시작되지 않았습니다"), watch);

    for (const plan of providerPlans.filter((candidate) => !candidate.prerequisite)) {
      process.stderr.write(
        `대화형 ${plan.provider} 로그인 창: tmux -L ${socketName} attach-session -t ${sessionName}:connectors\n`,
      );
      const executed = await executeProviderScenario(
        session,
        plan,
        environment,
        options.timeoutMs,
        identity.releaseDigest,
        options.signal,
      );
      providerScenarios.push(executed.scenario, ...executed.supplemental);
      if (executed.account && executed.correlationId && executed.attemptIds.length > 0) {
        providerEvidence.set(executed.scenario.id, {
          account: executed.account,
          correlationId: executed.correlationId,
          attemptIds: executed.attemptIds,
        });
      }
    }

    await requiredObserved({
      window: "daemon",
      step: "restart-stop",
      command: mass,
      arguments: ["local", "stop", "--json"],
      observation: { kind: "local-stop", expected: { statuses: ["stopped"] } },
    });
    await requiredObserved({
      window: "daemon",
      step: "restart-start",
      command: mass,
      arguments: ["local", "start", "--json"],
      observation: { kind: "local-start", expected: { endpoint, status: "started" } },
    });
    await requiredObserved({
      window: "user",
      step: "restart-status",
      command: mass,
      arguments: ["status", "--json"],
      observation: { kind: "application-status", expected: {} },
    });
    assertions.push("restart-status-verified");
    for (const scenario of providerScenarios.filter((candidate) => candidate.status === "passed")) {
      const evidence = providerEvidence.get(scenario.id);
      if (!evidence) continue;
      const { account } = evidence;
      const result = await runTmuxObservedCommand(session, {
        window: "connectors",
        step: `${scenario.id}-restart-doctor`,
        command: mass,
        arguments: ["subscription", "doctor", account.accountId, "--json"],
        environment,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        observation: {
          kind: "subscription-doctor",
          expected: {
            accountId: account.accountId,
            connectorId: account.connectorId,
            providerId: scenario.provider,
          },
        },
      });
      scenario.commands.push(result.command);
      if (result.command.exitCode !== 0 || !result.observation) {
        scenario.status = "failed";
        scenario.failureClass = classifyUatFailure(result.command.step, result.command.exitCode);
        scenario.endedAt = new Date().toISOString();
      } else {
        scenario.assertions.push("restart-account-doctor-verified");
        scenario.lineage.push(result.observation.digest);
        const lineage = await runTmuxObservedCommand(session, {
          window: "user",
          step: `${scenario.id}-restart-lineage`,
          command: mass,
          arguments: ["runtime", "lineage", "correlation", evidence.correlationId, "--json"],
          environment,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          observation: {
            kind: "runtime-subscription-lineage",
            expected: {
              correlationId: evidence.correlationId,
              accountId: account.accountId,
              providerId: scenario.provider,
              requireSettledSuccess: true,
            },
          },
        });
        scenario.commands.push(lineage.command);
        const attemptIds =
          lineage.observation?.facts.executions.flatMap((execution) =>
            execution.attempts.map((attempt) => attempt.attemptId),
          ) ?? [];
        if (
          lineage.command.exitCode !== 0 ||
          !lineage.observation ||
          JSON.stringify(attemptIds) !== JSON.stringify(evidence.attemptIds)
        ) {
          scenario.status = "failed";
          scenario.failureClass = classifyUatFailure(lineage.command.step, lineage.command.exitCode || 65);
        } else {
          scenario.assertions.push("restart-subscription-lineage-verified");
          scenario.lineage.push(lineage.observation.digest);
        }
        scenario.endedAt = new Date().toISOString();
      }
    }

    const backup = join(workspace.root, "backup.json");
    await requiredObserved({
      window: "user",
      step: "backup-create",
      command: mass,
      arguments: ["local", "backup", backup, "--json"],
      observation: { kind: "local-backup", expected: { path: backup } },
    });
    const backupMetadata = await stat(backup);
    if (!backupMetadata.isFile() || (backupMetadata.mode & 0o077) !== 0)
      throw new Error("UAT backup이 owner-only가 아닙니다");
    assertions.push("backup-owner-only");
    await requiredObserved({
      window: "daemon",
      step: "local-stop",
      command: mass,
      arguments: ["local", "stop", "--json"],
      observation: { kind: "local-stop", expected: { statuses: ["stopped"] } },
    });
    await stopTmuxBackgroundCommand(session, "watch");
    const restoreEnvironment = {
      ...environment,
      MASSION_MODE: "local",
      MASSION_DATABASE_URL: "rocksdb://./massion.db",
      MASSION_TOKEN_KEY_FILE: join(workspace.configHome, "massion", "token-key"),
      MASSION_CREDENTIAL_KEY_FILE: join(workspace.configHome, "massion", "credential-key"),
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspace.restoreDirectory, "workspaces"),
      MASSION_CONNECTOR_ROOT: join(workspace.restoreDirectory, "connectors"),
      MASSION_HTTP_PORT: String(port + 10),
      MASSION_REGISTRY_PORT: String(port + 11),
      MASSION_METRICS_PORT: String(port + 12),
    };
    const restore = await runTmuxObservedCommand(session, {
      window: "daemon",
      step: "backup-restore",
      command: server,
      arguments: ["restore", backup],
      environment: restoreEnvironment,
      cwd: workspace.restoreDirectory,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      observation: { kind: "server-restore", expected: { path: backup } },
    });
    commands.push(restore.command);
    if (restore.command.exitCode !== 0 || !restore.observation) {
      throw Object.assign(new Error("UAT backup restore JSON 검증이 실패했습니다"), restore.command);
    }
    lifecycleLineage.push(restore.observation.digest);
    const restoredServer = await startTmuxBackgroundCommand(session, {
      window: "daemon",
      step: "restore-server-start",
      command: server,
      arguments: [],
      environment: restoreEnvironment,
      cwd: workspace.restoreDirectory,
      signal: options.signal,
    });
    commands.push(restoredServer);
    if (restoredServer.exitCode !== 0)
      throw Object.assign(new Error("복구 server가 시작되지 않았습니다"), restoredServer);
    const restoredEndpoint = `http://127.0.0.1:${String(port + 10)}`;
    await required({
      window: "user",
      step: "restore-readiness",
      command: process.execPath,
      arguments: [
        "-e",
        "const u=process.argv[1];for(let i=0;i<120;i++){try{const r=await fetch(u+'/health/ready');const b=await r.json();if(r.ok&&b.status==='ready')process.exit(0)}catch{}await new Promise(v=>setTimeout(v,250))}process.exit(1)",
        restoredEndpoint,
      ],
      environment: restoreEnvironment,
    });
    assertions.push("backup-restored", "restore-ready");
    const cliConfigPath =
      process.platform === "darwin"
        ? join(workspace.home, "Library", "Application Support", "Massion", "config.json")
        : join(workspace.configHome, "massion", "config.json");
    await rebindUatCliEndpoint(cliConfigPath, restoredEndpoint);
    for (const scenario of providerScenarios.filter((candidate) => candidate.status === "passed")) {
      const evidence = providerEvidence.get(scenario.id);
      if (!evidence) continue;
      const lineage = await runTmuxObservedCommand(session, {
        window: "user",
        step: `${scenario.id}-restore-lineage`,
        command: mass,
        arguments: ["runtime", "lineage", "correlation", evidence.correlationId, "--json"],
        environment,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        observation: {
          kind: "runtime-subscription-lineage",
          expected: {
            correlationId: evidence.correlationId,
            accountId: evidence.account.accountId,
            providerId: scenario.provider,
            requireSettledSuccess: true,
          },
        },
      });
      scenario.commands.push(lineage.command);
      const restoredAttemptIds =
        lineage.observation?.facts.executions.flatMap((execution) =>
          execution.attempts.map((attempt) => attempt.attemptId),
        ) ?? [];
      if (
        lineage.command.exitCode !== 0 ||
        !lineage.observation ||
        JSON.stringify(restoredAttemptIds) !== JSON.stringify(evidence.attemptIds)
      ) {
        scenario.status = "failed";
        scenario.failureClass = classifyUatFailure(lineage.command.step, lineage.command.exitCode || 65);
      } else {
        scenario.assertions.push("restore-subscription-lineage-verified");
        scenario.lineage.push(lineage.observation.digest);
      }
      scenario.endedAt = new Date().toISOString();
    }
    await stopTmuxBackgroundCommand(session, "daemon");
    await verifyOperationalLogFile(join(workspace.stateHome, "massion", "server.log"), ownerIdentity);
    assertions.push("operational-log-redacted");
    await required({
      window: "daemon",
      step: "uninstall-release",
      command: join(workspace.prefix, "lib/massion", identity.version, "uninstall.sh"),
      arguments: [],
    });
    await required({
      window: "user",
      step: "uninstall-preserves-data",
      command: "/bin/sh",
      arguments: [
        "-c",
        'for name in mass massion-connector massion-server massion-tui; do test ! -e "$1/$name" && test ! -L "$1/$name" || exit 1; done; test ! -e "$2" && test ! -L "$2" && test -d "$3"',
        "uat-check",
        join(workspace.prefix, "bin"),
        join(workspace.prefix, "lib/massion", identity.version),
        join(workspace.dataHome, "massion"),
      ],
    });
    assertions.push("uninstall-data-preserved");
  } catch (error) {
    lifecycleFailure = {
      step: typeof error?.step === "string" ? error.step : "uat-orchestration",
      exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1,
    };
    if (!commands.some((command) => command.step === lifecycleFailure.step)) commands.push(lifecycleFailure);
    for (const plan of providerPlans.filter((candidate) => !candidate.prerequisite)) {
      if (!providerScenarios.some((scenario) => scenario.id === plan.id)) {
        const now = new Date().toISOString();
        providerScenarios.push({
          id: plan.id,
          provider: plan.provider,
          status: "failed",
          startedAt: now,
          endedAt: now,
          assertions: [],
          commands: [],
          lineage: identity ? [identity.releaseDigest] : [],
          failureClass: "product",
        });
      }
    }
  } finally {
    if (session && environment) {
      const mass = join(environment.MASSION_PREFIX, "bin", "mass");
      await runTmuxUatCommand(session, {
        window: "daemon",
        step: "cleanup-stop",
        command: mass,
        arguments: ["local", "stop"],
        environment,
        timeoutMs: 10_000,
      }).catch(() => undefined);
      await destroyTmuxUatSession({ socketName, sessionName, environment });
    }
  }
  if (!identity) {
    await rm(workspace.root, { recursive: true, force: true });
    throw new Error("commit-bound release archive preflight가 실패했습니다");
  }
  const endedAt = new Date().toISOString();
  const lifecycle = {
    id: "release-lifecycle",
    provider: "massion-local",
    status: lifecycleFailure ? "failed" : "passed",
    startedAt,
    endedAt,
    assertions,
    commands,
    lineage: [identity.releaseDigest, ...new Set(lifecycleLineage)],
    ...(lifecycleFailure ? { failureClass: classifyUatFailure(lifecycleFailure.step, lifecycleFailure.exitCode) } : {}),
  };
  const receipt = createSubscriptionUatReceipt({
    gitCommit: identity.gitCommit,
    releaseDigest: identity.releaseDigest,
    tmuxSession: sessionName,
    startedAt,
    endedAt,
    scenarios: [lifecycle, ...providerScenarios],
  });
  try {
    await atomicWriteSubscriptionUatReceipt(receiptPath, receipt);
    return receipt;
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

export function repositoryRootForScript(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

async function main() {
  if (process.argv[2] === "--internal-observe") {
    if (process.argv.length !== 4) {
      process.exitCode = 65;
      return;
    }
    process.exitCode = await runInternalObserver(process.argv[3]);
    return;
  }
  const arguments_ = parseSubscriptionUatArguments(process.argv.slice(2));
  if (arguments_.mode === "validate") {
    const receipt = validateSubscriptionUatReceipt(JSON.parse(await readFile(arguments_.path, "utf8")));
    process.stdout.write(`${JSON.stringify({ schema: receipt.schema, summary: receipt.summary })}\n`);
    return;
  }
  const repositoryRoot = repositoryRootForScript(import.meta.url);
  const signals = new globalThis.AbortController();
  const interrupt = () => signals.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const receipt = await runSubscriptionUat({ ...arguments_, repositoryRoot, signal: signals.signal });
    process.stdout.write(`${JSON.stringify({ schema: receipt.schema, summary: receipt.summary })}\n`);
    if (receipt.summary.failed > 0) process.exitCode = signals.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

function safeDiagnostic(error) {
  const message = error instanceof Error ? error.message : "Subscription UAT 실행이 실패했습니다";
  if (
    message.length < 1 ||
    message.length > 512 ||
    /[\0\r\n]/u.test(message) ||
    FORBIDDEN_STRING.some((pattern) => pattern.test(message)) ||
    /(?:^|[\s'"(])\/(?:Volumes|Users|home|private|tmp|var)\//u.test(message) ||
    /[A-Za-z]:\\/u.test(message)
  ) {
    return "Subscription UAT 실행이 실패했습니다. 비밀이 없는 사전조건을 확인해주세요";
  }
  return message;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${safeDiagnostic(error)}\n`);
    process.exitCode = 2;
  }
}
