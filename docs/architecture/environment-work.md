# Environment-backed member Work implementation plan (R-U2b)

> Execution: inline, using executing-plans and test-driven-development. CODEX-BRIEF's SPEED RULES v2 override full-suite/per-task-review defaults; the owner already authorized implementation.

**Goal:** A normal member Work reads an owned browser, fills declared fields from scoped secret requests, pauses at exact owner gates, resumes within its original run, and records observed results in the existing UI.

**Architecture:** Extend the existing owner-selected host manifest with bounded member environment declarations. The normal ConnectionWorkbench → SelectableTextRuntime → ConfiguredTextRuntime path consumes them; this is not a fixture-only runner. EnvironmentActions remains the claim/approval/no-replay boundary. Keep the live runtime and its original deadline/budget reservation while waiting, and serialize member steps sharing its browser. Existing effect admission/receipts record delivery and unknown outcomes; separate host observations establish facts, never payment execution or acceptance.

**Tech stack:** Node 24.19+ native TypeScript, existing Store/Application, native headless browser, no new dependencies.

**Spec:** [Browser actions](browser-actions.md), [environment actions](environment-actions.md), [secret sources](secret-sources.md), ADR 0001–0004, and the owner-approved R-U2 brief.

## Constraints and decisions

- Only declared native browser capabilities are offered. Models may name bounded element, wait, fact and secret-slot identifiers; they cannot supply selectors, origins, gates, secret values or execution authority.
- `EnvironmentWorkDefinition` carries member identity, exact HTTPS origin, declared elements, boolean fact predicates with public labels/kinds, bounded owner waits and secret request declarations. Validate it before startup side effects; use the existing host manifest, not another settings surface.
- Pin the definition and database feed in runtime activation. Never reopen an old browser run into a new session after restart; changed feed, inputs, ownership or configuration must fail closed. Owner cancellation and host drain remain available during waits.
- Parse only `massion-environment/v1` with bounded `act`, `wait` and `observe` operations. An action plan ends with a separate observation. Preserve existing `massion-step/v1` progress wording and ordinary text steps.
- Resolve an environment slot alias through SecretRequestsService's exact Work/member/purpose/request capability. Offer missing values through its existing owner UI before action admission; convert to temporary bytes only at the adapter boundary.
- Payment-gated actions are owner-approved intents only. A host-only acknowledgment may retire an approved non-executable intent so later read-only observation can proceed; it never invokes a payment adapter or creates a payment receipt.
- Persist Work checkpoints and bounded host observation references through a host-only command. Two aggregates are not atomic: deterministic identities and retained-result lookup bridge the Work and environment journals; uncertainty never authorizes another call.
- Browser page records reuse BrowserSessions and its private-origin rules. Facts come only from declared instrumentation; no page text proves an owner confirmation. No private page text, images or secret values enter durable facts.
- Use only current Work/card/sidebar/decision/progress slots. Do not edit screen contracts/prototypes or introduce scenario names into product source. Retain any gap not supported by real producers with a precise reason.

## Review focus

- Duplicate approvals and a lost projection/claim response must not deliver twice.
- Cancellation, drain, changed inputs and feed replacement must fence secret resolution and action admission.
- Owner waits preserve their original deadline/poll budget; text saying “done” cannot complete them.
- Private observations remain private after restart/error; fresh browser identity cannot revive approval.
- Approval and delivery remain distinct from observed order confirmation and independently accepted Work.

## Implementation sequence

- [x] **Host definitions and durable state:** add `src/environment-work.ts` with definition/plan validation, runtime binding/checkpoint types and host transition validation in `environment-work-state.ts`; extend `domain.ts` and `backup-lineage.ts`. Add focused rejection/replay tests first. Extend `host-connections.ts` manifest validation without changing existing manifests' behavior.
- [x] **Actual runtime path:** add `src/environment-work-service.ts`; reuse EnvironmentActions, SecretRequestsService and BrowserSessions. Wire the optional service through `configured-runtime.ts`, `selectable-runtime.ts`, `connection-workbench.ts` and normal `server.ts` startup. Test a real member run that pauses, resumes and reaches the existing independent verifier; test unknown/no-replay and cancellation boundaries before implementation.
- [x] **Owner and read surfaces:** expose exact-hash environment answers through the existing decisions endpoint and include applicable decisions in the correct member thread. Project host facts and waits into existing Work slots. Extend relevant server/UI tests for replaced feeds, expired gates and stale thread responses.
- [x] **Synthetic producers and delivery:** generate affected fixtures through real member/runtime commands against local HTTPS pages, with an out-of-band owner simulator and fake secret slots. Remove only proven allow-list gaps. Capture changed screens in both themes (at most six PNGs), run typecheck and affected tests, prepare one push and the prescribed CI/review loop.

## Verification boundary

Use fixtures/mocks and synthetic local pages only. Never run real sites, accounts, payments, models, keychain/vault tools or OS dialogs. Local tests use the brief's real-path TMPDIR. CI owns the full suite and all-screen contracts; a passing fixture is not real-provider evidence. PR #160 was merged by explicit lead approval at `c6d6d18`; any later findings on that slice belong here.

## Contract residuals

The native member fixtures keep the owner-approved contracts unchanged. Member-owned sidebar placement differs from the Representative-owned examples; live gates reject or cancel instead of deferring beyond the original deadline; private form fields and live-page identity chrome are not retained. Order-state observation supplies neither a vendor receipt nor payment execution. The targeted two-theme capture removes or replaces 36 old diagnostic identities and records 56 remaining identities (152 to 172 total); these are disclosed contract differences, not a claim that every screen matches its prototype.
