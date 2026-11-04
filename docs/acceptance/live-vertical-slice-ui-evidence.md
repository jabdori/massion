# Live first vertical slice through the browser UI

Date: 2026-11-04. Source: `main` `39b20b6` plus the UI fixes in this change. Normal CLI host with `--host-config` (subscription CLI manifest: `claude-sonnet-5-5`, `claude-haiku-5-5` via Claude Code; `gpt-6.1-terra` via Codex) and `--allow-live-model-calls`. SurrealDB 3.3.0, persistent volume. Mission `mission:ef6d4356-f025-48c4-85a9-69cbbba21f3f`, scope `p1-ui`.

Every product step below was performed in the browser workbench, not through the HTTP API: Mission creation, two scoped grants, Work admission, connection selection, check, Run, four Mission criteria revisions, explicit memory, Growth proposal, host evaluation, adoption, correction Work and revert. **Client 1** was the desktop app's built-in browser; **client 2** was a separate Playwright browser context with no shared storage, opened from the Mission link. Results were read back from the store; executor output was checked mechanically where the criteria allowed it.

## Gates of `first-slice.md`

| Gate | Result |
|---|---|
| User-authored Mission → executor → independent verifier → Record | ✅ Two accepted Works under criteria v1 (Haiku executor, Codex verifier), Records `3f4970c51136`, `3d0752efd773`; both outputs mechanically 9/9/9 words |
| Independently detect an incorrect candidate | ✅ Work `f4057f1b`: Sonnet computed the right total but added an explanation; criteria v4 require exactly one line. Verifier rejected it: "the total is correct, but … not exactly one line" (mechanically true) |
| Corrected artifact accepted with complete Records | ✅ Correction Work `work:b-fix-ui` pinned to the rejected original through the UI correction form; output `TOTAL: 3 cents`; Record `d42743d8a513`; original retained unchanged |
| Evaluate a memory improvement | ✅ Baseline `rounding@1` "Round each line" (explicit), candidate `rounding@2` "Round aggregate once" (learned, inactive). Host oracle `host-rounding-oracle/v1` on three owner orders: baseline 1/3, candidate 3/3 |
| Apply it to a later Work and observe its effect | ✅ Adopted **from client 2**. The next Works pinned `rounding@2` and produced `TOTAL: 3 cents` for two 3¢ items at 50% off |
| Revert without rewriting history | ✅ Reverted from client 1. Work C pinned `rounding@1` and produced `TOTAL: 4 cents` (per-line rounding), Record `90315fd3859a`; earlier Works still pin `rounding@2` |
| Second client continuation | ✅ Client 2 opened the Mission at the same revision (71), its adoption appeared in client 1 without reload (revision 72, cursor 277), and client 1's later Works and revert reached client 2 live (revision 135, 7 Works) |
| Interruption / no blind replay | ✅ Two Haiku Works under harder criteria (v2, v3) ended `unknown` (`cli_exit_1_api_error`: Claude Code exceeded the 2,048 cap while reasoning). Both remain blocked with one unknown effect; nothing was resent |
| Restart | ✅ After a host restart all seven Works, verdicts, Record checksums, unknown effects, Growth status `reverted` and memory flags read back identically; client 2 reconnected at revision 135 |

## Works (read back from the store)

| Work | Criteria | Executor | Executor in/out | Verifier in/out | Verdict | Acceptance | Memory pin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `350fb867` | v1 | haiku | 1,386 / 1,929 | 16,651 / 317 | passed | accepted | — |
| `be926dee` | v1 | haiku | 1,511 / 1,268 | 16,534 / 242 | passed | accepted | — |
| `f1d753a7` | v2 | haiku | unknown | — | — | pending, blocked | — |
| `a9da0727` | v3 | haiku | unknown | — | — | pending, blocked | — |
| `f4057f1b` (Work B) | v4 | sonnet | 1,402 / 75 | 16,689 / 227 | **failed** | failed | `rounding@2` |
| `b-fix-ui` (correction of B) | v4 | sonnet | 1,783 / 13 | 16,751 / 208 | passed | accepted | `rounding@2` |
| `91fe0e0c` (Work C, after revert) | v4 | sonnet | 1,404 / 96 | 16,662 / 228 | passed | accepted | `rounding@1` |

## UI defects found and fixed in this change

- The connection panel still said subscription CLIs were not implemented.
- Authorization choices showed only an opaque grant ID. They now name the executor and verifier models.
- The two `pattern="[a-zA-Z0-9:_-]{1,128}"` attributes are invalid under the `v` flag browsers use, so Chrome dropped that validation and logged an error. The hyphen is now escaped, and a regression test compiles every workbench pattern with `v`.

Checked and not a defect: the correction source list shows every Work, but ineligible Works are disabled.

## Limitations

- The rejection that drove the correction was a format violation found by the verifier, not an arithmetic error. Two attempts to provoke content errors under harder criteria ended `unknown` instead (CLI output cap), which is the documented subscription-CLI limitation.
- Growth evaluation is the host's deterministic rounding oracle; only the execution and verification around it used live models. Model-generated proposals, other Growth targets and automatic adoption remain open.
- Subscription-CLI evidence: Codex's serving model is reported as requested only, and CLI-internal requests are not single-send provable (see `subscription-cli-live-evidence.md`).
- One owner, one machine, seven Works: behavioural evidence, not a quality evaluation.
