# Zero-Command Onboarding and Local Runtime Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the personal installation start its local server automatically, make `massion init` an interactive onboarding command when arguments are omitted, and make the TUI/Web entrypoints explain failures instead of appearing silent.

**Architecture:** Keep explicit `massion local start` for scripts and diagnostics, but add a shared local-endpoint decision so interactive TUI, Web, and init flows start only the default loopback server. Remote or team profiles never start an unrelated local daemon. The TUI wrapper calls an internal `local ensure` operation before launching Bun, while the CLI uses the same decision for `--web` and `init`.

**Tech Stack:** Node.js 24, Bun 1.3 for OpenTUI, TypeScript, Vitest, shell release launcher, README and local-install runbook.

---

### Task 1: Define local auto-start and interactive init contracts

**Files:**
- Create: `apps/cli/src/local-entrypoint.ts`
- Create: `apps/cli/src/local-entrypoint.test.ts`
- Create: `apps/cli/src/onboarding.ts`
- Create: `apps/cli/src/onboarding.test.ts`

- [x] **Step 1: Write failing tests for endpoint selection**

Test that the default loopback endpoint is eligible for auto-start, a remote HTTPS endpoint is not, and a loopback endpoint on a different port is not silently redirected.

- [x] **Step 2: Run the endpoint tests and verify the expected failure**

Run: `pnpm --filter @massion/cli exec vitest run src/local-entrypoint.test.ts`

Expected: FAIL because the endpoint decision helpers do not exist.

- [x] **Step 3: Write failing tests for onboarding answers**

Test that two prompt answers produce the default local endpoint, owner email, and display name, and that blank answers return a human-readable validation error.

- [x] **Step 4: Run the onboarding tests and verify the expected failure**

Run: `pnpm --filter @massion/cli exec vitest run src/onboarding.test.ts`

Expected: FAIL because the onboarding collector does not exist.

- [x] **Step 5: Implement the minimal pure contracts**

Implement endpoint normalization/eligibility and an injected-question onboarding collector. Keep actual readline creation outside the pure collector so tests do not require a real terminal.

- [x] **Step 6: Run both focused test files and verify GREEN**

Run: `pnpm --filter @massion/cli exec vitest run src/local-entrypoint.test.ts src/onboarding.test.ts`

Expected: all tests pass with no warnings.

### Task 2: Add automatic local server preparation and interactive `init`

**Files:**
- Modify: `apps/cli/src/parser.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/main.test.ts` or create `apps/cli/src/main-entrypoint.test.ts`
- Modify: `apps/cli/src/init.test.ts`

- [x] **Step 1: Write failing parser and CLI contract tests**

Test that the internal `local ensure` subcommand parses, `massion init` without positional arguments requests onboarding input, and a local `--web` profile calls local preparation before ticket issuance.

- [x] **Step 2: Run the tests and verify RED**

Run: `pnpm --filter @massion/cli exec vitest run src/parser.test.ts src/main-entrypoint.test.ts src/init.test.ts`

Expected: FAIL because `local ensure` and onboarding preparation are not implemented.

- [x] **Step 3: Implement `local ensure` and automatic preparation**

Add a non-prominent `local ensure` branch that reads the selected profile when available, starts the local daemon only for the matching default loopback endpoint, and returns a no-op result for remote profiles. Call it from `--web` and from local `init`.

- [x] **Step 4: Implement interactive `massion init`**

When no endpoint/email/display name are supplied and stdin/stdout are TTYs, prompt for email and display name, use the default loopback endpoint, start the local daemon, then persist the profile through the existing bootstrap flow. Preserve the explicit positional form for scripts and return a clear non-TTY error when prompts cannot be shown.

- [x] **Step 5: Run focused CLI tests and verify GREEN**

Run: `pnpm --filter @massion/cli exec vitest run src/parser.test.ts src/main-entrypoint.test.ts src/init.test.ts src/local-entrypoint.test.ts src/onboarding.test.ts`

Expected: all tests pass.

### Task 3: Make the public launcher use automatic preparation and expose diagnostics

**Files:**
- Modify: `release/install.sh`
- Modify: `scripts/install-script.test.mjs`
- Modify: `scripts/local-release-install.test.mjs`

- [x] **Step 1: Write a failing launcher contract test**

Assert that the generated `massion` launcher invokes `local ensure` before the Bun TUI and propagates a preparation failure instead of silently discarding it.

- [x] **Step 2: Run the launcher test and verify RED**

Run: `node --test scripts/install-script.test.mjs scripts/local-release-install.test.mjs`

Expected: FAIL because the launcher currently executes Bun directly and never prepares the local server.

- [x] **Step 3: Implement the launcher preflight**

Run the bundled Node CLI with `local ensure --json` before starting TUI, suppress only successful JSON output, preserve stderr, and then execute the bundled Bun TUI. Keep the launcher’s explicit TTY gate and add a clear message for non-interactive invocation.

- [x] **Step 4: Run installer and release tests and verify GREEN**

Run: `node --test scripts/install-script.test.mjs scripts/local-release-install.test.mjs`

Expected: all installer and release lifecycle tests pass.

### Task 4: Document the simplified personal flow and dependency boundary

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/local-install.md`
- Modify: `docs/evidence/phase-29/massion-entrypoint-2026-07-15.md`

- [x] **Step 1: Document the new first-run flow**

Replace the required `local start` and positional `init` sequence with `massion init`, followed by `massion` or `massion --web`. Keep explicit server lifecycle commands in an advanced/diagnostic section.

- [x] **Step 2: Document runtime dependencies accurately**

State that pnpm is a repository/development dependency, while the current release runtime still needs Node.js 24 and Bun 1.3 because the TUI uses OpenTUI. Do not claim that a single-runtime release exists until the TUI runtime is migrated and verified.

- [x] **Step 3: Add troubleshooting for an apparently blank TUI**

Document `command -v massion`, `massion version`, `stty size`, PATH setup, the 80×24 minimum, and the requirement for an interactive TTY.

- [x] **Step 4: Run documentation checks**

Run: `CI=true pnpm format:check && CI=true pnpm verify:docs && git diff --check`

Expected: all checks pass.

### Task 5: Full verification and release decision

**Files:**
- Modify: `docs/evidence/phase-30/zero-command-onboarding-2026-07-16.md`

- [x] **Step 1: Run focused tests**

Run: `CI=true pnpm --filter @massion/cli test` and `node --test scripts/install-script.test.mjs scripts/local-release-install.test.mjs`.

- [x] **Step 2: Run repository verification gates**

Run: `CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm verify:security && CI=true pnpm verify:hardening`.

- [ ] **Step 3: Run a fresh tmux scenario**

In an isolated HOME, run `massion init` interactively, then `massion`, `massion --web`, `massion status`, and `massion local stop`. Capture the TUI frame and verify that the Web ticket is emitted.

- [x] **Step 4: Record evidence and decide whether to publish a new release**

Step 3의 첫 실행 온보딩·자동 서버·TUI 렌더링은 최종 아카이브에서 확인했지만, 별도 Web Console 티켓 캡처는 아직 수행하지 않았습니다. 공개 `v1.0.0`을 덮어쓰지 않고 다음 patch release에서 새 아카이브를 게시해야 합니다.

Record exact commits, test counts, dependency checks, and any remaining external provider-account validation. Do not retag `v1.0.0`; publish a new patch release only after the new installer artifact is rebuilt and verified.
