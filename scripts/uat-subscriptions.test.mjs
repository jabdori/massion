import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

import {
  atomicWriteSubscriptionUatReceipt,
  classifyUatFailure,
  createSubscriptionUatReceipt,
  createTmuxUatSession,
  createUatWorkspace,
  destroyTmuxUatSession,
  parseSubscriptionUatArguments,
  parseAndValidateObservedUatOutput,
  planProviderScenarios,
  planUnsupportedLineageScenarios,
  repositoryRootForScript,
  rebindUatCliEndpoint,
  runSubscriptionUat,
  runTmuxObservedCommand,
  runTmuxUatCommand,
  subscriptionUatRunPlan,
  subscriptionUatPolicy,
  validateOperationalLogText,
  validateCredentialPolicyAttemptLineage,
  validateFallbackAttemptLineage,
  validateReleaseBinding,
  validateSubscriptionUatReceipt,
  verifyOperationalLogFile,
} from "./uat-subscriptions.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const digest = `sha256:${"a".repeat(64)}`;

function scenario(overrides = {}) {
  return {
    id: "codex-personal-run",
    provider: "openai-codex",
    status: "passed",
    startedAt: "2026-07-12T12:00:00.000Z",
    endedAt: "2026-07-12T12:01:00.000Z",
    assertions: ["provider-health-verified", "application-run-terminal", "receipt-settled"],
    commands: [
      { step: "connect", exitCode: 0 },
      { step: "run", exitCode: 0 },
    ],
    lineage: [digest],
    ...overrides,
  };
}

test("비밀이 제거된 실제·미실행 시나리오만 Phase 24 UAT 영수증으로 만든다", () => {
  const receipt = createSubscriptionUatReceipt({
    gitCommit: "b".repeat(40),
    releaseDigest: digest,
    tmuxSession: "massion-uat-phase24",
    startedAt: "2026-07-12T11:59:00.000Z",
    endedAt: "2026-07-12T12:03:00.000Z",
    scenarios: [
      scenario(),
      scenario({
        id: "zai-live-account",
        provider: "zai-coding-plan",
        status: "not-run",
        assertions: [],
        commands: [],
        lineage: [],
        prerequisite: "provider-approval-required",
      }),
    ],
  });

  assert.equal(receipt.schema, "massion.subscription-uat.v1");
  assert.deepEqual(receipt.summary, { passed: 1, failed: 0, notRun: 1 });
  assert.deepEqual(validateSubscriptionUatReceipt(receipt), receipt);
});

test("이메일·token·개인 key·로컬 profile 경로는 어느 중첩 위치에서도 거부한다", () => {
  for (const leaked of [
    { output: "owner@example.com" },
    { token: "secret-value" },
    { detail: "Bearer abcdefghijklmnopqrstuvwxyz" },
    { detail: "-----BEGIN PRIVATE KEY-----" },
    { detail: "/Users/person/.codex/auth.json" },
    { detail: "/Volumes/private/massion/server.log" },
    { detail: "/tmp/massion/raw.json" },
    { detail: "/var/folders/private/profile" },
    { detail: "file:///private/tmp/massion-secret" },
  ]) {
    assert.throws(
      () =>
        validateSubscriptionUatReceipt({
          schema: "massion.subscription-uat.v1",
          gitCommit: "b".repeat(40),
          releaseDigest: digest,
          tmuxSession: "massion-uat-phase24",
          startedAt: "2026-07-12T11:59:00.000Z",
          endedAt: "2026-07-12T12:03:00.000Z",
          summary: { passed: 1, failed: 0, notRun: 0 },
          scenarios: [scenario({ evidence: leaked })],
        }),
      /비밀|개인정보|경로/u,
    );
  }
});

test("운영 로그도 영수증과 같은 전체 비밀·로컬 경로·file URL 규칙을 적용한다", () => {
  assert.equal(validateOperationalLogText('{"event":"server.ready","status":"ready"}', "owner-identity"), true);
  for (const leaked of [
    "owner-identity",
    "/Volumes/private/massion/server.log",
    "/Users/private/.codex/auth.json",
    "/tmp/massion/raw.json",
    "/var/folders/private/profile",
    "file:///private/tmp/massion-secret",
    "C:\\Users\\private\\.claude.json",
    "Bearer abcdefghijklmnopqrstuvwxyz",
  ]) {
    assert.throws(() => validateOperationalLogText(`log ${leaked}`, "owner-identity"), /비밀|개인정보|경로/u);
  }
});

test("실제 owner-only 운영 로그 파일에 로컬 경로가 섞이면 redaction assertion은 실패한다", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "massion-operational-log-test-"));
  const log = join(root, "server.log");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(log, '{"event":"server.ready","detail":"/Volumes/private/raw.json"}\n', { mode: 0o600 });
  await assert.rejects(async () => await verifyOperationalLogFile(log, "owner-identity"), /비밀|개인정보|경로/u);
  await writeFile(log, '{"event":"server.ready","status":"ready"}\n', { mode: 0o600 });
  await assert.doesNotReject(async () => await verifyOperationalLogFile(log, "owner-identity"));
});

test("성공·실패·미실행 상태가 실제 command와 선행조건에 맞지 않으면 거부한다", () => {
  const base = {
    gitCommit: "b".repeat(40),
    releaseDigest: digest,
    tmuxSession: "massion-uat-phase24",
    startedAt: "2026-07-12T11:59:00.000Z",
    endedAt: "2026-07-12T12:03:00.000Z",
  };
  assert.throws(
    () =>
      createSubscriptionUatReceipt({ ...base, scenarios: [scenario({ commands: [{ step: "run", exitCode: 1 }] })] }),
    /성공/u,
  );
  assert.throws(
    () =>
      createSubscriptionUatReceipt({
        ...base,
        scenarios: [scenario({ status: "not-run", assertions: [], commands: [], lineage: [] })],
      }),
    /선행조건/u,
  );
  assert.throws(
    () =>
      createSubscriptionUatReceipt({
        ...base,
        scenarios: [scenario(), scenario()],
      }),
    /중복/u,
  );
});

test("tmux 실행은 최종 local archive를 요구하고 provider 로그인은 명시적으로 동의해야 한다", () => {
  assert.throws(() => parseSubscriptionUatArguments(["--tmux"]), /--release/u);
  assert.throws(() => parseSubscriptionUatArguments(["--tmux", "--release", "release.tar.gz"]), /massion-local/u);

  const defaults = parseSubscriptionUatArguments([
    "--tmux",
    "--release",
    "artifacts/release-1.0.0/massion-local-1.0.0.tar.gz",
  ]);
  assert.equal(defaults.mode, "tmux");
  assert.equal(defaults.interactiveProviderLogin, false);
  assert.deepEqual(defaults.providers, ["codex", "claude", "zai"]);
  assert.deepEqual(defaults.approvedProviders, []);
  assert.equal(defaults.timeoutMs, 120_000);

  const optedIn = parseSubscriptionUatArguments([
    "--tmux",
    "--release",
    "artifacts/release-1.0.0/massion-local-1.0.0.tar.gz",
    "--providers",
    "claude,codex",
    "--interactive-provider-login",
    "--approved-providers",
    "claude",
    "--timeout-ms",
    "300000",
  ]);
  assert.equal(optedIn.interactiveProviderLogin, true);
  assert.deepEqual(optedIn.providers, ["claude", "codex"]);
  assert.deepEqual(optedIn.approvedProviders, ["claude"]);
  assert.equal(optedIn.timeoutMs, 300_000);
});

test("비대화형 구독 UAT는 사용자 승인 대기 없이 자동 승인 정책을 사용한다", () => {
  assert.deepEqual(subscriptionUatPolicy("openai-codex"), {
    providerId: "openai-codex",
    credentialPolicy: "adaptive",
    approvalMode: "automatic",
  });
});

test("구독 UAT 실행과 timeout 뒤 lineage 조회는 같은 공개 상관관계 ID를 사용한다", () => {
  const plan = subscriptionUatRunPlan("8b3a91c5-2fe2-4a3e-9a1e-1d32c32e23e6");
  assert.deepEqual(plan.runArguments, [
    "run",
    "subscription acceptance",
    "--correlation",
    "8b3a91c5-2fe2-4a3e-9a1e-1d32c32e23e6",
    "--json",
  ]);
  assert.deepEqual(plan.lineageArguments, [
    "runtime",
    "lineage",
    "correlation",
    "8b3a91c5-2fe2-4a3e-9a1e-1d32c32e23e6",
    "--json",
  ]);
});

test("CLI 사전조건 실패는 stack trace와 로컬 경로 없이 한 줄로 종료한다", () => {
  const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts/uat-subscriptions.mjs"), "--tmux"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--release/u);
  assert.doesNotMatch(result.stderr, /uat-subscriptions\.mjs:[0-9]+|\/Volumes\/|\/Users\/|\/home\//u);
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("release manifest·archive·bundle·현재 clean commit이 모두 일치해야 한다", () => {
  const bytes = Buffer.from("final-release-archive");
  const archiveDigest = createHash("sha256").update(bytes).digest("hex");
  const commit = "c".repeat(40);
  const input = {
    archiveName: "massion-local-1.0.0.tar.gz",
    archiveBytes: bytes.length,
    archiveDigest: `sha256:${archiveDigest}`,
    manifest: {
      schema: "massion.release.v1",
      version: "1.0.0",
      gitCommit: commit,
      sourceDigest: `sha256:${"f".repeat(64)}`,
      toolchains: { node: "24.18.0", bun: "1.3.14", pnpm: "10.30.3" },
      artifacts: [
        {
          name: "massion-local-1.0.0.tar.gz",
          bytes: bytes.length,
          digest: `sha256:${archiveDigest}`,
        },
      ],
    },
    bundle: {
      schema: "massion.release-bundle.v1",
      version: "1.0.0",
      gitCommit: commit,
      sourceDigest: `sha256:${"f".repeat(64)}`,
      entrypoints: {
        mass: "runtime/node_modules/@massion/cli/dist/main.js",
        connector: "runtime/node_modules/@massion/connector/dist/main.js",
        server: "runtime/node_modules/@massion/server/dist/main.js",
        tui: "runtime/node_modules/@massion/tui/dist/main.js",
      },
    },
    currentCommit: commit,
    currentSourceDigest: `sha256:${"f".repeat(64)}`,
    gitStatus: "",
  };

  assert.deepEqual(validateReleaseBinding(input), {
    gitCommit: commit,
    releaseDigest: `sha256:${archiveDigest}`,
    version: "1.0.0",
  });
  assert.throws(() => validateReleaseBinding({ ...input, gitStatus: " M source.ts\n" }), /clean/u);
  assert.throws(() => validateReleaseBinding({ ...input, currentCommit: "d".repeat(40) }), /commit/u);
  assert.throws(() => validateReleaseBinding({ ...input, archiveDigest: `sha256:${"e".repeat(64)}` }), /digest/u);
  assert.throws(
    () =>
      validateReleaseBinding({
        ...input,
        bundle: { ...input.bundle, sourceDigest: `sha256:${"0".repeat(64)}` },
      }),
    /source digest/u,
  );
  assert.throws(
    () => validateReleaseBinding({ ...input, currentSourceDigest: `sha256:${"1".repeat(64)}` }),
    /source digest/u,
  );
});

test("HOME·XDG·prefix·복구 경로를 한 owner-only 임시 작업공간에 격리한다", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "massion-uat-workspace-test-"));
  context.after(async () => await rm(parent, { recursive: true, force: true }));

  const workspace = await createUatWorkspace(parent);
  for (const path of [
    workspace.root,
    workspace.home,
    workspace.prefix,
    workspace.configHome,
    workspace.dataHome,
    workspace.stateHome,
    workspace.temporaryDirectory,
    workspace.extractedDirectory,
    workspace.restoreDirectory,
  ]) {
    const metadata = await stat(path);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0, `${path}는 owner-only여야 합니다`);
  }
});

test("복구 서버 검증용 CLI endpoint만 owner-only config에서 원자 교체하고 token 참조를 보존한다", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "massion-uat-cli-rebind-"));
  const configPath = join(root, "config.json");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(
    configPath,
    `${JSON.stringify({
      schemaVersion: "massion.cli.config.v1",
      selectedProfile: "local",
      profiles: {
        local: { endpoint: "http://127.0.0.1:7331", tokenReference: "file:/private/token-reference" },
      },
    })}\n`,
    { mode: 0o600 },
  );

  await rebindUatCliEndpoint(configPath, "http://127.0.0.1:7441");
  const rebound = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(rebound.profiles.local.endpoint, "http://127.0.0.1:7441");
  assert.equal(rebound.profiles.local.tokenReference, "file:/private/token-reference");
  assert.equal((await stat(configPath)).mode & 0o077, 0);

  await chmod(configPath, 0o644);
  await assert.rejects(async () => await rebindUatCliEndpoint(configPath, "http://127.0.0.1:7551"), /0600/u);
});

test("대화형 로그인 비동의와 승인되지 않은 Claude·Z.AI는 실제 성공 대신 not-run으로 계획한다", () => {
  assert.deepEqual(planProviderScenarios(["codex", "claude", "zai"], false, []), [
    {
      id: "codex-live-subscription",
      provider: "openai-codex",
      prerequisite: "interactive-login-required",
    },
    {
      id: "claude-live-subscription",
      provider: "anthropic-claude-code",
      prerequisite: "provider-approval-required",
    },
    {
      id: "zai-live-subscription",
      provider: "zai-coding-plan",
      prerequisite: "provider-approval-required",
    },
  ]);
  assert.deepEqual(planProviderScenarios(["codex", "claude", "zai"], true, ["claude", "zai"]), [
    { id: "codex-live-subscription", provider: "openai-codex" },
    {
      id: "claude-live-subscription",
      provider: "anthropic-claude-code",
      prerequisite: "public-provider-connect-unavailable",
    },
    {
      id: "zai-live-subscription",
      provider: "zai-coding-plan",
      prerequisite: "public-provider-connect-unavailable",
    },
  ]);
});

test("공개 JSON 응답은 봉투·상태·provider·account·policy·종료 계보를 모두 확인해야 증거가 된다", () => {
  const account = parseAndValidateObservedUatOutput(
    "subscription-accounts",
    JSON.stringify({
      schemaVersion: "massion.application.v1",
      operation: "subscription.accounts",
      data: [
        {
          accountId: "account-uat-0001",
          providerId: "openai-codex",
          alias: "UAT Codex",
          scope: "personal",
          canManage: true,
          connectorId: "connector-uat-0001",
          connectorLocation: "server",
          connectorExecutionKind: "agent-runtime",
          connectorStatus: "ready",
          billingKind: "consumer-subscription",
          status: "active",
          version: 1,
        },
      ],
    }),
    { providerId: "openai-codex", alias: "UAT Codex" },
  );
  assert.deepEqual(account.facts, {
    accountId: "account-uat-0001",
    billingKind: "consumer-subscription",
    connectorExecutionKind: "agent-runtime",
    connectorId: "connector-uat-0001",
    connectorLocation: "server",
    providerId: "openai-codex",
    scope: "personal",
    status: "active",
    version: 1,
  });
  assert.match(account.digest, /^sha256:[a-f0-9]{64}$/u);

  const policyCommand = parseAndValidateObservedUatOutput(
    "subscription-policy-command",
    JSON.stringify({
      schemaVersion: "massion.application.v1",
      commandId: "command-uat-0001",
      correlationId: "correlation-uat-0001",
      operation: "subscription.policy.configure",
      outcome: "succeeded",
      resource: { type: "SubscriptionPolicy", id: "openai-codex", revision: 2 },
      data: {
        providerId: "openai-codex",
        credentialPolicy: "adaptive",
        approvalMode: "review",
        version: 2,
        source: "configured",
      },
    }),
    { providerId: "openai-codex", credentialPolicy: "adaptive", approvalMode: "review" },
  );
  assert.deepEqual(policyCommand.facts, {
    approvalMode: "review",
    credentialPolicy: "adaptive",
    providerId: "openai-codex",
    source: "configured",
    version: 2,
  });

  const terminal = parseAndValidateObservedUatOutput(
    "application-run-terminal",
    JSON.stringify({
      schemaVersion: "massion.cli.run.v1",
      type: "result",
      status: "completed",
      runId: "run-uat-0001",
      correlationId: "correlation-uat-0001",
      cursor: 42,
    }),
    {},
  );
  assert.deepEqual(terminal.facts, {
    correlationId: "correlation-uat-0001",
    cursor: 42,
    runId: "run-uat-0001",
    status: "completed",
  });

  assert.throws(() => parseAndValidateObservedUatOutput("subscription-accounts", "not-json", {}), /JSON/u);
  assert.throws(
    () =>
      parseAndValidateObservedUatOutput(
        "subscription-accounts",
        JSON.stringify({ schemaVersion: "massion.application.v1", operation: "subscription.accounts", data: [] }),
        { providerId: "openai-codex", alias: "UAT Codex" },
      ),
    /account|계정/u,
  );
  assert.throws(
    () =>
      parseAndValidateObservedUatOutput(
        "subscription-policy-command",
        JSON.stringify({
          schemaVersion: "massion.application.v1",
          commandId: "command-uat-0001",
          correlationId: "correlation-uat-0001",
          operation: "subscription.policy.configure",
          outcome: "accepted",
          data: {
            providerId: "openai-codex",
            credentialPolicy: "adaptive",
            approvalMode: "review",
            version: 2,
            source: "configured",
          },
        }),
        { providerId: "openai-codex", credentialPolicy: "adaptive" },
      ),
    /outcome|완료/u,
  );
  assert.throws(
    () =>
      parseAndValidateObservedUatOutput(
        "application-run-terminal",
        JSON.stringify({
          schemaVersion: "massion.cli.run.v1",
          type: "result",
          status: "blocked",
          runId: "run-uat-0001",
          correlationId: "correlation-uat-0001",
          cursor: 42,
        }),
        {},
      ),
    /terminal|종료|completed/u,
  );
});

test("설치·초기화·상태·catalog·doctor·quota·backup·restore JSON도 상태값까지 닫힌 계약으로 검증한다", () => {
  const observed = (kind, value, expected = {}) =>
    parseAndValidateObservedUatOutput(kind, typeof value === "string" ? value : JSON.stringify(value), expected);
  assert.equal(
    observed("exact-text", "Massion AgentOS 1.0.0\n", { value: "Massion AgentOS 1.0.0" }).facts.matched,
    true,
  );
  assert.deepEqual(
    observed("connector-doctor", {
      schema: "massion.connector-doctor.v1",
      status: "ready",
      runtime: "bundled",
    }).facts,
    { runtime: "bundled", status: "ready" },
  );
  assert.equal(
    observed(
      "local-start",
      { status: "started", pid: 123, endpoint: "http://127.0.0.1:7331" },
      { status: "started", endpoint: "http://127.0.0.1:7331" },
    ).facts.status,
    "started",
  );
  assert.equal(
    observed("local-stop", { status: "stopped", pid: 123 }, { statuses: ["stopped"] }).facts.status,
    "stopped",
  );
  assert.equal(
    observed("local-backup", { status: "backed-up", path: "/safe/backup.json" }, { path: "/safe/backup.json" }).facts
      .status,
    "backed-up",
  );
  assert.deepEqual(
    observed(
      "initialize-owner",
      { profile: "local", endpoint: "http://127.0.0.1:7331", tokenId: "token-uat-0001" },
      { profile: "local", endpoint: "http://127.0.0.1:7331" },
    ).facts,
    { endpoint: "http://127.0.0.1:7331", profile: "local" },
  );
  assert.deepEqual(
    observed("application-status", {
      schemaVersion: "massion.application.v1",
      operation: "system.status",
      data: {
        status: "ready",
        mode: "local",
        database: "surrealdb-3.0.0",
        modelRuntime: "limited",
        modelRuntimeDetails: { missingRoutes: ["coding-balanced"], blockedRoutes: [] },
      },
    }).facts,
    { mode: "local", modelRuntime: "limited", status: "ready" },
  );
  assert.deepEqual(
    observed(
      "subscription-providers",
      {
        schemaVersion: "massion.application.v1",
        operation: "subscription.providers",
        data: [
          {
            providerId: "openai-codex",
            displayName: "OpenAI Codex",
            authKinds: ["device-code", "cli-profile"],
            executionKind: "agent-runtime",
            connectionSurface: "server-and-edge",
            billingKinds: ["consumer-subscription"],
            modelDiscovery: "protocol",
            quotaDiscovery: "protocol",
            protocols: ["codex-app-server"],
            protocol: "codex-app-server",
            availability: "supported",
            officialDocumentation: "https://developers.openai.com/codex/auth",
            credentialPolicies: ["adaptive", "round-robin"],
            runtimeCapabilities: {
              accountIsolation: "profile-root",
              output: "final-text-only",
              cancellation: "protocol",
              session: "protocol",
              permissionBridge: "protocol",
              multipleAccounts: "profile-isolated",
              maturity: "contract-tested",
              approvalModes: ["automatic", "deny"],
              approvalModesBySurface: {
                server: ["automatic", "review", "deny"],
                edge: ["automatic", "deny"],
              },
            },
            verified: false,
          },
        ],
      },
      { providers: [{ providerId: "openai-codex", availability: "supported" }] },
    ).facts,
    { providers: ["openai-codex"] },
  );
  const doctor = observed(
    "subscription-doctor",
    {
      schemaVersion: "massion.application.v1",
      operation: "subscription.doctor",
      data: [
        {
          accountId: "account-uat-0001",
          providerId: "openai-codex",
          alias: "UAT Codex",
          accountStatus: "active",
          connectorId: "connector-uat-0001",
          connectorLocation: "server",
          connectorStatus: "ready",
          quotaStatus: "unknown",
          action: "none",
        },
      ],
    },
    { accountId: "account-uat-0001", connectorId: "connector-uat-0001", providerId: "openai-codex" },
  );
  assert.equal(doctor.facts.action, "none");
  assert.deepEqual(
    observed(
      "subscription-quota",
      { schemaVersion: "massion.application.v1", operation: "subscription.quota", data: [] },
      { accountId: "account-uat-0001" },
    ).facts,
    { accountId: "account-uat-0001", available: false },
  );
  assert.deepEqual(
    observed(
      "subscription-quota",
      {
        schemaVersion: "massion.application.v1",
        operation: "subscription.quota",
        data: [
          {
            accountId: "account-uat-0001",
            windows: [
              {
                kind: "weekly",
                remainingRatio: 0.5,
                resetsAt: "2026-07-19T00:00:00.000Z",
                observedAt: "2026-07-12T00:00:00.000Z",
                confidence: "provider-reported",
              },
            ],
            exhausted: false,
            observedAt: "2026-07-12T00:00:00.000Z",
          },
        ],
      },
      { accountId: "account-uat-0001" },
    ).facts,
    { accountId: "account-uat-0001", available: true, exhausted: false, windows: 1 },
  );
  assert.deepEqual(
    observed(
      "server-restore",
      {
        timestamp: "2026-07-12T00:00:00.000Z",
        level: "info",
        event: "server.restore.completed",
        path: "/safe/backup.json",
        checksum: "a".repeat(64),
        migrations: 24,
      },
      { path: "/safe/backup.json" },
    ).facts,
    { event: "server.restore.completed", migrations: 24 },
  );
  assert.throws(
    () =>
      observed("connector-doctor", {
        schema: "massion.connector-doctor.v1",
        status: "ready",
        runtime: "bundled",
        unverified: true,
      }),
    /알 수 없는/u,
  );
});

test("계정 선택 정책과 fallback은 서로 다른 실제 attempt 식별자 계보가 없으면 거부한다", () => {
  const attempts = [
    {
      attemptId: "attempt-uat-0001",
      sequence: 1,
      accountId: "account-uat-0001",
      credentialRef: "a".repeat(64),
      providerId: "provider-uat-0001",
      modelId: "model-uat-0001",
      status: "failed",
      failureSignal: "rate-limit",
    },
    {
      attemptId: "attempt-uat-0002",
      sequence: 2,
      accountId: "account-uat-0002",
      credentialRef: "b".repeat(64),
      providerId: "provider-uat-0002",
      modelId: "model-uat-0002",
      status: "succeeded",
      fallbackFrom: "attempt-uat-0001",
    },
  ];
  assert.deepEqual(validateCredentialPolicyAttemptLineage("round-robin", attempts), {
    policy: "round-robin",
    attemptIds: ["attempt-uat-0001", "attempt-uat-0002"],
  });
  assert.deepEqual(validateCredentialPolicyAttemptLineage("adaptive", attempts), {
    policy: "adaptive",
    attemptIds: ["attempt-uat-0001", "attempt-uat-0002"],
  });
  const fillFirstAttempts = [
    attempts[0],
    { ...attempts[0], attemptId: "attempt-uat-0003", sequence: 2 },
    { ...attempts[1], attemptId: "attempt-uat-0004", sequence: 3 },
  ];
  assert.deepEqual(validateCredentialPolicyAttemptLineage("fill-first", fillFirstAttempts), {
    policy: "fill-first",
    attemptIds: ["attempt-uat-0001", "attempt-uat-0003", "attempt-uat-0004"],
  });
  assert.deepEqual(validateFallbackAttemptLineage("rate-limit", attempts), {
    fallbackFrom: "attempt-uat-0001",
    fallbackTo: "attempt-uat-0002",
    signal: "rate-limit",
  });
  assert.throws(
    () =>
      validateCredentialPolicyAttemptLineage("round-robin", [
        attempts[0],
        { ...attempts[1], accountId: attempts[0].accountId, credentialRef: attempts[0].credentialRef },
      ]),
    /서로 다른|distinct/u,
  );
  assert.throws(() => validateFallbackAttemptLineage("timeout", attempts), /signal|원인/u);
  assert.throws(
    () => validateFallbackAttemptLineage("rate-limit", [attempts[0], { ...attempts[1], fallbackFrom: "wrong" }]),
    /fallbackFrom|계보/u,
  );
});

test("공개 Runtime 구독 계보 응답은 correlation·attempt·lease·terminal 정합성을 검증한다", () => {
  const observed = parseAndValidateObservedUatOutput(
    "runtime-subscription-lineage",
    JSON.stringify({
      schemaVersion: "massion.application.v1",
      operation: "runtime.execution.subscription-lineage",
      data: {
        correlationId: "correlation-uat-0001",
        executions: [
          { executionId: "execution-empty", status: "succeeded", attempts: [] },
          {
            executionId: "execution-subscription",
            status: "succeeded",
            attempts: [
              {
                attemptId: "attempt-uat-0001",
                sequence: 1,
                accountId: "account-uat-0001",
                credentialRef: "a".repeat(64),
                providerId: "openai-codex",
                modelId: "gpt-5.6-sol",
                status: "succeeded",
                quotaSnapshotId: "quota-uat-0001",
                routingPolicyVersion: 2,
                effectiveCredentialPolicy: "adaptive",
                subscriptionPolicyVersion: 3,
                emittedTokens: 4,
                sideEffectsStarted: true,
                fallbackAllowed: false,
                lease: {
                  leaseId: "lease-uat-0001",
                  connectorId: "connector-uat-0001",
                  adapterId: "codex",
                  state: "settled",
                },
                terminal: {
                  outcome: "completed",
                  inputTokens: 3,
                  outputTokens: 4,
                  emittedTokens: 4,
                  sideEffectsStarted: true,
                },
              },
            ],
          },
        ],
      },
    }),
    {
      correlationId: "correlation-uat-0001",
      accountId: "account-uat-0001",
      providerId: "openai-codex",
      requireSettledSuccess: true,
    },
  );

  assert.deepEqual(observed.facts, {
    correlationId: "correlation-uat-0001",
    executions: [
      { executionId: "execution-empty", status: "succeeded", attempts: [] },
      {
        executionId: "execution-subscription",
        status: "succeeded",
        attempts: [
          {
            accountId: "account-uat-0001",
            attemptId: "attempt-uat-0001",
            credentialRef: "a".repeat(64),
            leaseState: "settled",
            modelId: "gpt-5.6-sol",
            providerId: "openai-codex",
            sequence: 1,
            status: "succeeded",
          },
        ],
      },
    ],
  });
});

test("공개 계보로도 자동 재현할 fixture가 없는 고급 시나리오만 정확한 reason으로 not-run 계획한다", () => {
  assert.deepEqual(planUnsupportedLineageScenarios(), [
    { id: "round-robin-attempt-lineage", prerequisite: "second-account-required" },
    { id: "fill-first-attempt-lineage", prerequisite: "second-account-required" },
    { id: "adaptive-attempt-lineage", prerequisite: "second-account-required" },
    { id: "share-unshare-lease-lineage", prerequisite: "second-user-required" },
    { id: "offline-fallback-lineage", prerequisite: "public-failure-injection-unavailable" },
    { id: "rate-limit-fallback-lineage", prerequisite: "public-failure-injection-unavailable" },
    { id: "timeout-fallback-lineage", prerequisite: "public-failure-injection-unavailable" },
    { id: "suspend-resume-terminal-lineage", prerequisite: "approval-checkpoint-required" },
  ]);
});

test("실패 command 단계와 공개 종료 코드로 원인을 과장 없이 분류한다", () => {
  assert.equal(classifyUatFailure("codex-live-subscription-connect", 3), "authentication");
  assert.equal(classifyUatFailure("codex-live-subscription-connect", 7), "provider");
  assert.equal(classifyUatFailure("codex-live-subscription-connect", 1), "product");
  assert.equal(classifyUatFailure("codex-live-subscription-quota", 7), "quota");
  assert.equal(classifyUatFailure("codex-live-subscription-quota", 65), "product");
  assert.equal(classifyUatFailure("codex-live-subscription-run", 124), "network");
  assert.equal(classifyUatFailure("codex-live-subscription-run", 130), "cancelled");
  assert.equal(classifyUatFailure("connector-doctor", 1), "product");
});

test("격리된 tmux에 daemon·user·connectors·watch 창을 만들고 raw pane capture 없이 종료 코드만 받는다", async (context) => {
  const socketName = `massion-uat-test-${String(process.pid)}-${Date.now().toString(36)}`;
  const sessionName = "massion-uat-phase24-test";
  const root = await mkdtemp(join(tmpdir(), "massion-uat-shell-test-"));
  const sentinel = join(root, "unexpected-side-effect");
  const workingDirectory = join(root, "working directory with spaces");
  await mkdir(workingDirectory, { recursive: true });
  const canonicalWorkingDirectory = await realpath(workingDirectory);
  context.after(async () => await destroyTmuxUatSession({ socketName, sessionName }));
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const session = await createTmuxUatSession({ socketName, sessionName, shell: "/bin/sh" });
  assert.deepEqual(session.windows, ["daemon", "user", "connectors", "watch"]);
  const succeeded = await runTmuxUatCommand(session, {
    window: "user",
    step: "status-ready",
    command: "/bin/sh",
    arguments: ["-c", "exit 0"],
    timeoutMs: 5_000,
  });
  const failed = await runTmuxUatCommand(session, {
    window: "connectors",
    step: "provider-doctor",
    command: "/bin/sh",
    arguments: ["-c", "exit 17"],
    timeoutMs: 5_000,
  });
  assert.deepEqual(succeeded, { step: "status-ready", exitCode: 0 });
  assert.deepEqual(failed, { step: "provider-doctor", exitCode: 17 });
  assert.equal("stdout" in succeeded, false);
  assert.equal("stderr" in failed, false);
  assert.equal("output" in succeeded, false);

  const cwdResult = await runTmuxUatCommand(session, {
    window: "user",
    step: "working-directory-with-spaces",
    command: process.execPath,
    arguments: ["-e", 'require("node:fs").writeFileSync(process.env.CWD_SENTINEL, process.cwd())'],
    environment: {
      CWD_SENTINEL: join(workingDirectory, "cwd.txt"),
    },
    cwd: canonicalWorkingDirectory,
    timeoutMs: 5_000,
  });
  assert.deepEqual(cwdResult, { step: "working-directory-with-spaces", exitCode: 0 });
  assert.equal(await readFile(join(workingDirectory, "cwd.txt"), "utf8"), canonicalWorkingDirectory);

  const hostile = `value'; touch '${sentinel}'; #`;
  const safelyQuoted = await runTmuxUatCommand(session, {
    window: "user",
    step: "shell-argument-safety",
    command: "/bin/sh",
    arguments: ["-c", 'test "$1" = "$EXPECTED"', "uat-shell", hostile],
    environment: { EXPECTED: hostile },
    timeoutMs: 5_000,
  });
  assert.deepEqual(safelyQuoted, { step: "shell-argument-safety", exitCode: 0 });
  await assert.rejects(async () => await access(sentinel));
});

test("tmux JSON 관찰기는 raw 출력 파일 없이 검증된 최소 사실과 digest만 돌려준다", async (context) => {
  const socketName = `massion-uat-observed-${String(process.pid)}-${Date.now().toString(36)}`;
  const sessionName = "massion-uat-phase24-observed";
  const root = await mkdtemp(join(tmpdir(), "massion-uat-observed-test-"));
  await chmod(root, 0o700);
  const workingDirectory = join(root, "observed working directory with spaces");
  await mkdir(workingDirectory, { recursive: true });
  const canonicalWorkingDirectory = await realpath(workingDirectory);
  context.after(async () => await destroyTmuxUatSession({ socketName, sessionName }));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const environment = { TMPDIR: root };
  const session = await createTmuxUatSession({ socketName, sessionName, shell: "/bin/sh", environment });

  const valid = await runTmuxObservedCommand(session, {
    window: "connectors",
    step: "observed-policy",
    command: process.execPath,
    arguments: [
      "-e",
      `if (process.cwd() !== process.argv[1]) process.exit(9); process.stdout.write(JSON.stringify(${JSON.stringify({
        schemaVersion: "massion.application.v1",
        operation: "subscription.policy",
        data: [
          {
            providerId: "openai-codex",
            credentialPolicy: "adaptive",
            approvalMode: "review",
            version: 2,
            source: "configured",
          },
        ],
      })}))`,
      canonicalWorkingDirectory,
    ],
    cwd: canonicalWorkingDirectory,
    environment,
    observation: {
      kind: "subscription-policy-query",
      expected: { providerId: "openai-codex", credentialPolicy: "adaptive", approvalMode: "review", version: 2 },
    },
    timeoutMs: 5_000,
  });
  assert.deepEqual(valid.command, { step: "observed-policy", exitCode: 0 });
  assert.deepEqual(valid.observation.facts, {
    approvalMode: "review",
    credentialPolicy: "adaptive",
    providerId: "openai-codex",
    source: "configured",
    version: 2,
  });
  assert.match(valid.observation.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal("stdout" in valid, false);
  assert.equal("raw" in valid.observation, false);

  const invalid = await runTmuxObservedCommand(session, {
    window: "connectors",
    step: "observed-invalid-json",
    command: process.execPath,
    arguments: ["-e", 'process.stdout.write("not-json")'],
    environment,
    observation: { kind: "subscription-policy-query", expected: { providerId: "openai-codex" } },
    timeoutMs: 5_000,
  });
  assert.notEqual(invalid.command.exitCode, 0);
  assert.equal(invalid.observation, undefined);
  assert.deepEqual(await readdir(workingDirectory), []);
});

test("중단 신호는 실행 중인 tmux command를 종료 코드 130으로 정리한다", async (context) => {
  const socketName = `massion-uat-signal-${String(process.pid)}-${Date.now().toString(36)}`;
  const sessionName = "massion-uat-phase24-signal";
  context.after(async () => await destroyTmuxUatSession({ socketName, sessionName }));
  const session = await createTmuxUatSession({ socketName, sessionName, shell: "/bin/sh" });
  const signals = new globalThis.AbortController();
  setTimeout(() => signals.abort(), 100).unref();

  const result = await runTmuxUatCommand(session, {
    window: "daemon",
    step: "signal-cleanup",
    command: "/bin/sh",
    arguments: ["-c", "sleep 10"],
    timeoutMs: 5_000,
    signal: signals.signal,
  });
  assert.deepEqual(result, { step: "signal-cleanup", exitCode: 130 });
});

test("stale 전용 tmux session은 release preflight 실패 전에도 제거한다", async (context) => {
  const socketName = "massion-uat-phase24";
  const sessionName = "massion-uat-phase24";
  context.after(async () => await destroyTmuxUatSession({ socketName, sessionName }));
  await createTmuxUatSession({ socketName, sessionName, shell: "/bin/sh" });

  await assert.rejects(
    async () =>
      await runSubscriptionUat({
        repositoryRoot,
        release: join(repositoryRoot, "artifacts/missing/massion-local-1.0.0.tar.gz"),
        providers: ["codex"],
        interactiveProviderLogin: false,
        timeoutMs: 5_000,
      }),
    /preflight/u,
  );
  const stale = spawnSync("tmux", ["-L", socketName, "has-session", "-t", `=${sessionName}`], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.notEqual(stale.status, 0);
});

test("검증된 receipt를 0600으로 원자 교체하고 실패한 receipt는 쓰지 않는다", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "massion-uat-receipt-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "evidence", "receipt.json");
  const first = createSubscriptionUatReceipt({
    gitCommit: "b".repeat(40),
    releaseDigest: digest,
    tmuxSession: "massion-uat-phase24",
    startedAt: "2026-07-12T11:59:00.000Z",
    endedAt: "2026-07-12T12:03:00.000Z",
    scenarios: [scenario()],
  });
  await atomicWriteSubscriptionUatReceipt(path, first);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), first);

  const second = createSubscriptionUatReceipt({
    ...first,
    endedAt: "2026-07-12T12:04:00.000Z",
    scenarios: [scenario({ endedAt: "2026-07-12T12:02:00.000Z" })],
  });
  await atomicWriteSubscriptionUatReceipt(path, second);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), second);
  await assert.rejects(
    async () =>
      await atomicWriteSubscriptionUatReceipt(path, {
        ...second,
        scenarios: [{ ...second.scenarios[0], detail: "Bearer abcdefghijklmnopqrstuvwxyz" }],
      }),
    /비밀|개인정보/u,
  );
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), second);
  await access(path);
});

test("receipt directory symbolic link를 따라가거나 외부 directory 권한을 바꾸지 않는다", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "massion-uat-receipt-link-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const external = join(root, "external");
  const linked = join(root, "linked-evidence");
  await mkdir(external, { mode: 0o755 });
  await chmod(external, 0o755);
  await symlink(external, linked, "dir");
  const receipt = createSubscriptionUatReceipt({
    gitCommit: "b".repeat(40),
    releaseDigest: digest,
    tmuxSession: "massion-uat-phase24",
    startedAt: "2026-07-12T11:59:00.000Z",
    endedAt: "2026-07-12T12:03:00.000Z",
    scenarios: [scenario()],
  });

  await assert.rejects(
    async () => await atomicWriteSubscriptionUatReceipt(join(linked, "receipt.json"), receipt),
    /directory/u,
  );
  assert.equal((await stat(external)).mode & 0o777, 0o755);
  await assert.rejects(async () => await access(join(external, "receipt.json")));
});

test("공백이 있는 file URL도 실제 repository root로 복원한다", () => {
  assert.equal(repositoryRootForScript(import.meta.url), repositoryRoot);
});

test("Phase 24 evidence JSON Schema는 validator와 같은 exact receipt 계약을 선언한다", async () => {
  const schema = JSON.parse(
    await readFile(join(repositoryRoot, "docs/evidence/phase-24/subscription-uat.schema.json"), "utf8"),
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "https://massion.dev/schemas/subscription-uat.v1.json");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schema",
    "gitCommit",
    "releaseDigest",
    "tmuxSession",
    "startedAt",
    "endedAt",
    "summary",
    "scenarios",
  ]);
  assert.equal(schema.properties.schema.const, "massion.subscription-uat.v1");
  assert.equal(schema.$defs.instant.pattern, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$");
  assert.equal(schema.$defs.scenario.additionalProperties, false);
  assert.equal(schema.$defs.command.additionalProperties, false);
  assert.deepEqual(schema.$defs.scenario.properties.prerequisite.enum, [
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
});
