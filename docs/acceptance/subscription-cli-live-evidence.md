# Subscription CLI live evidence (issue #5, first live vertical slice)

Date: 2026-11-04. Source: `main` `a552698` plus branch `feat/subscription-cli-adapters`. Host: macOS, Node 26.8.2 (repository pins 24.19.0), SurrealDB 3.3.0 in Docker with a persistent volume. Normal CLI started with `--host-config <manifest> --allow-live-model-calls`.

This is the first run of the product path — Mission → Work → executor → independent verifier → Record — against real models. Both roles used the owner's existing subscription logins through the official CLIs (`claude -p`, `codex exec`); no API key was configured and API-key variables are removed from the child environment. Evidence class remains `real-provider` with `realProviderVerified: false`; one owner, one machine and nine Works establish behaviour, not model quality.

## Connections

| Role | Backend | Exact model | Model identity in receipt |
| --- | --- | --- | --- |
| Executor | `claude-code-cli` (Claude Code 2.1.317) | `claude-sonnet-5-5`, `claude-haiku-5-5` | reported by the CLI (`modelUsage`) and required to match |
| Verifier | `codex-cli` (Codex CLI 0.166.0) | `gpt-6.1-terra` | requested only; Codex events do not report the serving model |

## Results (values read back from the store)

| Mission | Work | Executor | Executor usage in/out | Verifier usage in/out | Verdict | Acceptance | Mechanical check |
| --- | --- | --- | --- | --- | --- | --- | --- |
| p1-a-cli1 | work:a | sonnet | 1,629 / 79 | 20,667 / 260 | passed | accepted | 3 bullets, source facts only |
| p1-b-cli1 | work:b-wrong | sonnet | 1,650 / 439 | 20,916 / 262 | passed | accepted | Work asked for 5 bullets and an invented statistic; executor followed Mission criteria instead and said so in a note |
| p1-d-cli1 | work:d1 | sonnet | 1,655 / 603 | 20,859 / 366 | passed | accepted | words [9,9,9] ✔ |
| p1-d-cli1 | work:d2 | sonnet | 1,649 / 915 | 20,863 / 372 | passed | accepted | words [9,9,9] ✔ |
| p1-d-cli1 | work:d3 | sonnet | unknown | — | — | pending, blocked | output exceeded the 1,024 cap → `unknown` effect |
| p1-d-cli4 | work:d1 | haiku | 1,678 / 1,454 | 20,679 / 257 | passed | accepted | words [9,9,9] ✔ |
| p1-d-cli4 | work:d2 | haiku | 1,682 / 79 | 20,867 / 353 | **failed** | failed | words [10,9,11] ✔ rejection correct |
| p1-d-cli4 | work:d2-fix (correction of d2) | haiku | 2,064 / 79 | 20,992 / 391 | **failed** | failed | words [11,9,12] ✔ rejection correct |
| p1-d-cli4 | work:d2-fix2 (correction of d2-fix) | sonnet | 2,044 / 993 | 21,167 / 373 | passed | accepted | words [9,9,9] ✔ |

Scenario D used criteria a verdict can be checked against mechanically ("exactly 9 whitespace-separated words per bullet"). In all six such verdicts the independent verifier agreed with the mechanical count, including both rejections; its reasons quoted the exact counts.

## Gates

- **Accepted Record from live models:** work:a, Record `51944606c491…`.
- **Wrong → rejected → corrected → accepted:** d2 → d2-fix → d2-fix2, each correction pinned to the previous Work; rejected originals are retained unchanged. The final acceptance changed executor model, which is a new Work, not a retry inside an Attempt.
- **Unknown outcome, no replay:** work:d3's executor exceeded its cap (Claude Code continued internally), leaving one `unknown` effect. A later preflight reported `work_already_started`, `work_blocked`, `work_not_fresh`, `budget_exceeded`; a new run request returned `already-started`; `run-ownership` reported `replayPermitted: false`; the effect list was unchanged.
- **Restart:** after stopping and restarting the host (new manifest revision), all Missions, verdicts, Record checksums and the `unknown` effect read back identically; grants were not recreated.
- **Network-disconnect scenario (C):** not run; the d3 cap overrun exercised the same unknown/no-replay path from a different cause.

## Review corrections re-verified live

An independent three-lens review found, and this branch fixed before publication: Codex shell/exec/code-mode tools were still available during the turn (read-only sandbox still permits file reads); the child environment was a denylist, so base-URL or alternate-auth variables could redirect a "subscription" run; timeouts killed only the direct child; stdout was decoded per chunk. After the fixes, a live prompt instructing Codex to `cat ~/.zshrc` returned `NO TOOLS` with no tool item, both subscription logins still worked with the allowlisted environment, and scenario A was accepted again (`mission:p1-a-cli5`, 352 output tokens).

## Limitations observed

- **Hidden CLI-internal calls.** When Claude Code hits its output cap it continues internally (observed `num_turns: 4`, 4× cap) before exiting 1. One Massion effect can therefore correspond to several upstream requests; such runs stay `unknown`.
- **Codex output is not capped upstream.** `-c model_max_output_tokens` was ignored (929 tokens for a 64 cap). Over-cap output fails closed as `unknown`; size Codex caps generously.
- **Fixed overhead.** With the adapter's final flags Claude Code costs ~650 input tokens per call (88,962 with default CLI settings) and Codex ~16k input tokens (about 20k before its tools were disabled).
- **Verifier language.** Codex wrote check reasons in Korean (account locale). Verdict structure was unaffected.
- **Partial driver runs.** Missions `p1-d-cli2` and `p1-d-cli3` exist from a scenario driver error (reused command identities, rejected by idempotency); they contain no runs.
- Six mechanically checked verdicts are a smoke test of judgement, not an evaluation.
