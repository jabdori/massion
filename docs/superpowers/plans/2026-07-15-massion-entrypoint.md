# Massion Entry Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `massion` the single user-facing entry point that opens TUI by default, opens the Web Console with `--web`, and guides an uninitialized user through `massion init`.

**Architecture:** The release launcher dispatches interactive no-argument invocations to the bundled TUI and all subcommands to the Node CLI. The CLI issues a short-lived Web login ticket through the authenticated local or team endpoint, while the application HTTP server optionally serves the bundled Web assets from the same origin. `mass` compatibility is intentionally absent; the release exposes only `massion`, `massion-server`, and `massion-connector` wrappers. The repository root also provides a version-pinned, hash-verifying `curl | bash` bootstrap installer.

**Tech Stack:** Node.js 24, Bun 1.3, TypeScript, React/Vite Web bundle, Node `http` server, Vitest, Node test runner, shell release installer.

---

### Task 1: Freeze the command contract with failing tests

**Files:**
- Modify: `apps/cli/src/parser.test.ts`
- Modify: `apps/tui/src/main.test.ts`
- Modify: `scripts/local-release-install.test.mjs`

- [x] **Step 1: Write the failing parser tests**

Add tests asserting `--web` is recognized as a top-level Web action, ordinary subcommands remain CLI invocations, and `init` remains the only bootstrap command.

- [x] **Step 2: Write the failing first-run TUI test**

Run TUI with a missing config path and assert the output tells the user to run `massion init`, without exposing a raw filesystem `ENOENT` message.

- [x] **Step 3: Write the failing release contract test**

Change the release fixture expectations from public `mass`/`massion-tui` links to one public `massion` link, while keeping `massion-server` and `massion-connector` as managed internal helpers.

- [x] **Step 4: Run only the affected tests and verify RED**

Run:

```sh
pnpm --filter @massion/cli test -- --runInBand
pnpm --filter @massion/tui test -- --runInBand
node --test scripts/local-release-install.test.mjs
```

Expected result: failures identify the missing `--web`, first-run guidance, and new release command contract.

### Task 2: Implement the single `massion` launcher

**Files:**
- Modify: `release/install.sh`
- Modify: `release/uninstall.sh`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/local-release-install.test.mjs`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/tui/src/main.ts`

- [x] **Step 1: Add the public launcher wrapper**

Generate only `bin/massion` as the public CLI/TUI wrapper. With no arguments, it checks that stdin and stdout are TTYs, then executes the bundled TUI; otherwise it prints the CLI help. With arguments, it executes the Node CLI. `--web` is forwarded to the CLI. The wrapper exports the bundled server path and Web root for local daemon startup.

- [x] **Step 2: Keep internal runtime entrypoints out of PATH**

Keep `massion-server`, `massion-connector`, and the bundled TUI file inside the installed release directory, but do not create public symlinks for `massion-tui` or `mass`.

- [x] **Step 3: Rename the CLI package bin metadata**

Change the package bin name to `massion`; update help text and first-run wording to use `massion` consistently.

- [x] **Step 4: Add first-run guidance**

When the TUI config is missing, return a concise Korean message with the exact `massion init http://127.0.0.1:7331 <email> "<표시명>"` command instead of a raw filesystem error.

- [x] **Step 5: Run the focused tests and verify GREEN**

Run the Task 1 commands again. Expected result: all focused tests pass and no public `mass` command remains in the release fixture.

### Task 3: Add the Web login command

**Files:**
- Create: `apps/cli/src/web-login.ts`
- Create: `apps/cli/src/web-login.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/main.test.ts`

- [x] **Step 1: Write failing Web ticket tests**

Test that an authenticated profile receives a five-minute ticket, rejects malformed responses, never places the ticket in the URL, and reports a missing profile with the `massion init` instruction.

- [x] **Step 2: Implement ticket issuance**

Load the selected CLI profile and token through the existing secure `CliConfigStore`/token reference path, POST a random command ID to `/api/v1/web/login-tickets`, validate the response shape, and return the endpoint root plus the one-time code. Keep the code in stdout only; do not persist it.

- [x] **Step 3: Implement browser opening as an injected dependency**

Use `open` on macOS and `xdg-open` on Linux, with a safe fallback that prints the URL. Expose the opener as a dependency so tests never launch a real browser.

- [x] **Step 4: Dispatch `massion --web`**

Recognize the top-level flag before ordinary CLI parsing. Issue the ticket, open the configured Web URL, and print the five-minute code and URL. If no profile exists, print the initialization command and exit without network access.

- [x] **Step 5: Run the focused CLI tests and verify GREEN**

Run:

```sh
pnpm --filter @massion/cli test -- --runInBand
```

### Task 4: Serve the bundled Web Console in local mode

**Files:**
- Modify: `packages/application/src/http-server.ts`
- Modify: `packages/application/src/http-server.test.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/product.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/distribution/package.json`
- Modify: `scripts/build-release.mjs`
- Modify: `release/install.sh`

- [x] **Step 1: Write failing static Web tests**

Configure an HTTP server with a temporary Web root and assert `/` serves `index.html`, a known asset is served with the correct content type, SPA routes fall back to `index.html`, path traversal is rejected, and API/health routes keep their existing behavior.

- [x] **Step 2: Add the optional Web root to the HTTP server**

Add a validated absolute `webRoot` option. Serve only regular files below that root for `GET`/`HEAD`, set `no-cache` for `index.html`, and never serve secrets or files outside the root.

- [x] **Step 3: Thread `MASSION_WEB_ROOT` through server bootstrap**

Parse the optional environment variable, pass it into `ApplicationHttpServer`, and keep team deployments able to use Caddy’s existing static Web stage.

- [x] **Step 4: Build and package Web assets**

Build `@massion/web` as part of the distribution build, copy `apps/web/dist` into the local release runtime, and export its path from the installed server launcher.

- [x] **Step 5: Run application and distribution tests**

Run:

```sh
pnpm --filter @massion/application test
pnpm --filter @massion/server typecheck
node --test scripts/build-release.test.mjs scripts/local-release-install.test.mjs
```

### Task 5: Update documentation and verification contracts

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/local-install.md`
- Modify: `docs/operations/self-hosting-install.md`
- Modify: `CHANGELOG.md`
- Create: `install.sh`
- Modify: `scripts/verify-release.mjs`
- Create: `docs/evidence/phase-29/massion-entrypoint-2026-07-15.md`

- [x] **Step 1: Document the first-run sequence**

Document `massion init`, then `massion` for TUI, `massion --web` for Web, and move `massion run` into the automation section. Explain that an uninitialized invocation prints the init command.

- [x] **Step 2: Remove obsolete public command references**

Replace public `mass` and `massion-tui` examples and update install/uninstall instructions to the single `massion` command.

- [x] **Step 3: Record evidence and known boundaries**

Record the TUI first-run guidance, Web ticket behavior, local static Web health check, and the fact that `mass` compatibility is intentionally not provided before public release.

- [x] **Step 4: Run the complete verification gates**

Run:

```sh
pnpm verify
pnpm verify:security
pnpm verify:hardening
pnpm release:build /private/tmp/massion-release-20260715-entrypoint
CI=true pnpm verify:release /private/tmp/massion-release-20260715-entrypoint
```

- [x] **Step 5: Commit the completed feature**

```sh
git add apps packages release scripts docs README.md CHANGELOG.md
git commit -m "feat(cli): make massion the unified interactive entrypoint"
```

### Self-review checklist

- [x] `massion` without a profile guides the user to `massion init`.
- [x] `massion` after initialization opens TUI only in an interactive terminal.
- [x] `massion --web` issues a short-lived ticket without putting it in a URL.
- [x] Local Web assets are served from the same loopback origin as the API.
- [x] `mass` and `massion-tui` are absent from the public install prefix.
- [x] Root `install.sh` downloads a pinned release and verifies its manifest and SHA-256 digest before delegating to the bundle installer.
- [ ] Release install, uninstall, clean clone, security, and hardening tests pass.
