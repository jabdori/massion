# E7 acceptance evidence

Fixture-class evidence only. No real account login, credential-file read or model invocation was used for verification. Desktop security settings are unchanged.

- Node 24.21.0: review-fix related tests passed 289, failed 0, skipped 1. The skipped case requires an actual SurrealDB test instance.
- `npm run typecheck`: passed.
- Scoped copy lint: 29 files, no blocking findings; the new first-experience source is included in the keyed-copy gate.
- Impeccable detector on the changed UI: no findings.
- [Screen report](report.md): all six target states in both themes passed the blocking accessible-name, text-budget, token and region checks. [Dark pairs](pairs/dark) and [light pairs](pairs/light) compare the approved artboards with the running production page.
- [B19 baseline](b19-baseline.json): the supplemental member-settings contract has 12 existing failures in each theme, identical on the unchanged baseline. It contains no first-greeting requirement; B21-done is the greeting contract.

## Commands

```sh
npm run typecheck
node --test tests/assistant-conversation.test.ts tests/member-work-surface.test.ts tests/first-experience.test.ts tests/conversation-cards.test.ts tests/surface-shell.test.ts tests/ui-copy.test.ts tests/ui-copy-lint.test.ts tests/ui-contract-fixtures.test.ts tests/ui-contract-assets.test.ts tests/work-room-visual.test.ts tests/settings-surface.test.ts tests/results-schedules-surface.test.ts
UI_CONTRACTS_BLOCKING=1 UI_CONTRACTS_OUTPUT=docs/acceptance/e7 node scripts/ui-contracts/run.mjs B1 B1-signin B1-first B1-first-calc B1-first-later B21-done
```

On macOS, set TMPDIR to a real directory under `/private/tmp`, as required by the repository brief. The checked runtime was Node 24.21.0. The full repository suite and all screen contracts are left to CI under the owner's verification budget.

## Review-fix verification

Reproduced the three CI regressions unchanged, then verified the existing conversation-first and database-reset/late-response tests pass. First-run UI now requires explicit login-detection metadata and cannot restart after a database reset. This adds no conversation read or command. Added regression coverage for a configured connection without a detected subscription, reset with cached/refreshed login metadata, the B1 lettered card and the deferred Gmail paragraph/link. Compared both themes against the artboards: B1 has a separate greeting, an A–D card and no extra header menu; B1-first-later uses a centered paragraph and text link, with distinct DOM identity from the approval card.

## Observed behavior and limits

Selecting, deferring or reopening a first Work proposal sends no command. Assign uses the existing owner-message command and keeps drafts and unknown delivery fenced. No calculation answer is hardcoded in production: B1-first-calc is a controlled response fixture. Member introductions are stable projections of durable admission data, not generated model turns or new conversation writes.

Detection reports only CLI kind and detected/absent/unknown state. Provider buttons start only the fixed official CLI login commands; overlapping/unknown starts are fenced for the host lifetime and host drain aborts pending login processes. Unsupported or missing CLIs fail closed. Installed subscription presence does not configure a model, enable live calls, create grants or establish a usable Representative route. Those existing owner/host settings remain required. Mail connection opens existing Apps settings; Gmail authorization and CLI installation are outside this slice.
