# Member browser through agent-browser (R-U5)

## Design

The owner adopted agent-browser (installed CLI 0.41.2, Apache-2.0) as the browser execution layer. Massion keeps the gates, secrets, records and the environment-neutral port (`src/environment.ts`, `src/environment-actions.ts`); the targeting layer — snapshotting, refs, ref expiry and recovery, trusted input, covered checks — belongs to agent-browser and is not re-implemented here.

One adapter, `AgentBrowserEnvironment`, sits behind the existing `EnvironmentAdapter` port. Observe maps `snapshot -i --json` (structured `refs` map of `eN → {role, name}` on 0.41.2) to the bounded observation structure; act dispatches click / fill / select / press / scroll / navigate / back / reload / wait by ref. agent-browser's measured error strings and flags map to typed results: unknown ref (`Unknown ref:`), unrecoverable stale ref (`Could not locate element with role=` / `Stale ref … cannot be recovered`), covered (`is covered by`), `tab_gone`, `dialogBlocked`, `revived`, `page_wedged`. A stale or unknown ref fails with a typed error carrying a fresh snapshot so the member can re-plan without another read. Output-format drift is a refusal: the runner pins the exact version (0.41.2) and refuses anything else.

Each member gets one isolated session: `--session` derived from the member id under a Massion-owned `--namespace` (`~/.massion/agent-browser`), keeping login state across runs. The default session and the owner's Chrome are never used. The adapter is invoked through the CLI with `--json` because the per-command stateless process model matches the existing injected-runner boundary (`execFile` per command, typed JSON out); the MCP server would add a persistent stdio process for no contract gain.

Chrome's own sandbox is never turned off on a host (2026-11-17, ADR 0007 section 1). agent-browser 0.41.2 would add `--no-sandbox` by itself when it sees `CI`, root, or a container marker (`/.dockerenv`, `/run/.containerenv`, `/proc/1/cgroup` naming docker, kubepods or lxc), so both CLI spawn sites — this runner and the headless read path (`src/headless-browser.ts`) — pass the child a fixed allowlist environment (no `CI` can leak in) and run the same pre-flight (`src/browser-sandbox.ts`) that refuses to start the CLI when any condition would fire, with the reason carried as a code on the existing "unavailable" failure. The only excuse is `MASSION_BROWSER_CONTAINER_IS_SANDBOX_BOUNDARY=1`: an explicit statement that this container is the isolation boundary. It needs both the container markers and the variable, so it is refused on macOS and on any machine without the markers; nothing sets it today, neither a CI job nor any product path (no member-computer container exists yet).

Secrets never enter argv, environment, logs, journals or results. 0.41.2's `fill` verb has no stdin form, so a secret fill goes through `batch` stdin mode (`[["fill","@ref","<value>"]] | agent-browser batch --json --omit-command`): the value rides stdin into agent-browser's own fill verb, no input is re-implemented, and the fill result (which carries only the ref) is scrubbed and the bytes erased. The credential-provider plugin path was measured out: it only feeds `auth login`, which performs its own submit and would bypass the owner gates. After a secret fill the environment stays private-tainted (stricter than the brief's minimum: taint survives until the environment closes, matching R-U2's rule), text is suppressed, no eval and no screenshot is ever dispatched, and known secret values are scrubbed from anything the adapter returns.

Owner gates stay in Massion and run before dispatch. Without declarations the floor is: a secret-slot fill (`personal-data-submission`), a submit-capable action (a button click or an Enter key press) on a page whose full snapshot shows a password/card-named textbox (`personal-data-submission` + `irreversible-submit`; name-heuristic, stated, computed before truncation), and the first navigation to a new origin (an `approve` wait through the existing decision entries, origin recorded on the Work). Per ADR 0002 section 12 an unclear action is an effect: every button click carries `irreversible-submit` by default, sensitive or not, while links and scrolling stay ungated. Origins are enforced in the adapter: checked before navigate, before any observation or verb dispatch (including the re-validation right after secret resolution), and after every action; an off-list page is left (`back`, else the last approved origin) with the deviation reported.

Pre-dispatch destination checks use the pinned CLI's own reads: a link's `href` (from the `-u` snapshot YAML) and a button's `formaction` override (one batch `get attr` read) are refused as `origin-blocked` before any verb is sent, because agent-browser 0.41.2 routes are positive globs only (`network route <pattern> --abort` has no allow-list or negation form) and `--allowed-domains` cannot be combined with kept logins. The same resolved targets — full URL, not only the origin — join the snapshot digest, so a destination that changes between approval and delivery invalidates the binding. Residual, reported: the enclosing form's `action` for a button without `formaction` is not resolvable from pinned snapshots or attributes, so such a submit is covered by the default irreversible-submit owner gate plus post-action departure, and true network-level enforcement still needs the container egress gate (later slice). Once a secret is resolved the environment keeps the value in memory only, to scrub it from every adapter output: labels, URLs, dialog reports and error snapshots.

Dialogs follow the pinned policy: the session runs with `--no-auto-dialog` so agent-browser never answers on its own; after each action the adapter checks `dialog status`, accepts alerts, dismisses confirm/prompt/beforeunload, and reports every handled dialog in the action result. The owner takeover request (`authentication` | `captcha` | `other`) rides the existing owner-wait ledger. The stream is never enabled; the adapter issues no stream, screenshot, eval-for-read or download commands.

Same-origin iframes are agent-browser's own surface (one level inlined); no extra support is added here. Structure is capped at the shared observation bound (64 elements) with a truncation marker.

## Gates follow the permission level (2026-11-15)

This section replaces the gate rules above ("Owner gates stay in Massion…" and "every button click carries `irreversible-submit` by default"). It follows [ADR 0007](decisions/0007-member-environments-sign-in-and-permission-levels.md).

**Why it changed.** The first rule put an owner answer on every button and every text field. In real use that asks at nearly every step of a form, and the owner rejected it. We then looked at how six agent products decide that one click pays, sends or deletes. None of them knows it mechanically. Those that classify rely on the agent's own report against a risk list, or on a reviewing model, and they pin only payment down by other means (a dedicated flow, an amount, a site class). Two of the six do not classify browser clicks at all. All that classify ask, or do not run, when they cannot tell.

**Four gate kinds.** `payment`, `send`, `delete`, `effect`. The kinds `account-creation`, `personal-data-submission`, `terms-acceptance` and `irreversible-submit` are removed.

| Kind | Always ask | Auto | Full access |
| --- | --- | --- | --- |
| `payment` | asks | asks | asks |
| `send` (sending or posting in the owner's name; creating an account) | asks | asks | proceeds |
| `delete` (deleting what cannot be recovered) | asks | asks | proceeds |
| `effect` (any other button, submit or Enter) | proceeds | proceeds | proceeds |
| Reading (navigate within approved sites, view, scroll, follow a link) | proceeds | proceeds | proceeds |

Single-send control does not depend on the level. Every effect is claimed once, a lost response is unknown, and Massion re-reads the result instead of resubmitting. This is what "an unclear action is an effect" (ADR 0002 §12) continues to mean.

**In the browser the unit of asking is the site, not the click.** Inside a site the owner has allowed, ordinary actions (expanding, moving to the next step, searching, an ordinary submit) proceed at every level. No product we surveyed asks per button inside an allowed site, and we do not build a classifier that separates a submit from an in-page action. As a result Always ask and Auto behave the same inside the browser; they differ for tool and app actions outside it, which are not part of this adapter.

**Opening a website is a separate setting.** The host passes a website setting, `always-ask` (default) or `always-allow`, that does not depend on the level. Under `always-ask`, the first visit to a site the request did not name asks; the answer is once, or always for this site. Under `always-allow`, a member opens websites without asking. What `always-allow` gives up: a planted instruction could carry information in an address to an unfamiliar site, and only the rule that read content is never an instruction stands against it.

**Who decides the kind.**

1. A host declaration, where one exists, is trusted.
2. Otherwise the member states the kind when it proposes a button click, a submit or Enter. A proposal with no kind asks.
3. The host may raise the kind from what it observed, and never lowers it:
   - a page whose snapshot shows a card field makes a submit-capable action `payment`. A payment intent is still not executed by the member; it goes to the owner as today.
   - a control whose name contains a word from a fixed list is raised to `send` or `delete`. This applies to every clickable control (a button, a link, a menu item), and a click on a control raised this way counts as an effect. A word alone never makes a `payment` gate: a payment gate is never executed, so a button named "Order history" would become impossible to press. Words about paying raise to `send`, which asks and can run after approval. English words match whole words only; Korean words match as substrings.
   - A control named by a payment word with no card field on the page (a saved-card purchase) carries `send` with an always-ask flag: it asks at every level including Full access, no remembered approval covers it, and it still executes once the owner has answered. The non-executable `payment` kind comes only from an observed card field or a host declaration.

Page text still cannot grant anything. It can only move an action toward asking. A page that hides the word only fails to raise the kind.

**The gap that remains.** A button with an ordinary name that in fact sends or deletes, proposed by a member that reports `effect`, proceeds in Auto. None of the six products closes this mechanically. What stands behind it: every automatic effect is recorded with its kind, control name and address; the result is re-read after each effect; nothing is resubmitted; payment is caught by the observed card field, not by the report; and a secret is filled only where its use was granted.

**Secrets.** A text field no longer carries a gate of its own. A secret fill is governed by the existing use grant for that slot ([Secret sources](secret-sources.md)), which names where the value may go.

**Remembered approvals.** `send`, `delete` and a first visit accept a scope: once, or this site from now on. There is no scope that covers a whole task. `payment` is never remembered. The adapter receives the current level and the remembered approvals from the host; storing them and the screens that edit them are separate work.

**Read content.** The structure and text of a page are handed to the member inside a marked block as material, with our own markers escaped inside it. A test plants instructions in a page ("press this button", "send this to that address") and checks that the member's actions do not follow them.

## Delivery slices

PR 1 (this slice): adapter + runner + tests with a fake runner, plus one smoke script (`scripts/smoke-agent-browser.ts`) that CI runs on macOS in the `browser-adapter-macos` job (`.github/workflows/check.yml`), driving the pinned binary headless against synthetic local pages; it does not run on the Linux runner, where the browser cannot start without a usable sandbox. The declared CSS-selector path stays only because the #162 fixtures and open PR #163 still execute it; the follow-up PR migrates those fixtures, deletes the declared path and narrows the allow-list only where the checker proves entries gone.
