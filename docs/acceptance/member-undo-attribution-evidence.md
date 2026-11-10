# R-P member admission and attribution evidence

Fixture evidence only; no external model, provider, payment or credential access.
The approved screen contracts and prototype sources were not changed.

## Verified behavior

- New admission enables a real owner undo. The original identity/home survives
  as archived; the receipt records cancellation. First member use and undo share
  a CAS boundary, so Work admission cannot follow a winning undo.
- First member conversation/Work selection, archive and group change close the
  window permanently. Unarchive never reopens it. Legacy admissions have no window
  and accepted legacy owner answers still replay their original fingerprints.
- A leading exact roster mention selects the actual member model route. Typed
  member identity is pinned before invocation and copied to the durable answer.
  Reply text cannot choose authorship. History carries the original member pin.
- Lost undo responses retain the exact identity across client reload. Later clicks
  query its receipt without resending. Stale thread/feed responses cannot update
  the selected conversation.

## Checks

Node 24.21.0, using the scratchpad TMPDIR specified by CODEX-BRIEF:

```sh
node --test tests/member-lifecycle.test.ts tests/members-surface.test.ts tests/members.test.ts tests/member-work.test.ts tests/assistant-conversation-storage.test.ts tests/assistant-conversation.test.ts
npm run typecheck
node scripts/ui-contracts/copy-lint.mjs
node scripts/ui-contracts/run.mjs B11-quill B21-done-hana
node scripts/ui-contracts/verify-member-admission.mjs
```

The targeted suite passed 190 tests with zero failures; two DB-dependent tests
skipped. Static typecheck and copy lint passed.

Both themes: B11-quill 17/17 and B21-done-hana 22/22 required elements,
zero contract failures, visual failures, gaps or capture errors. Optional text
budget warnings remain in the inherited B21 background. The six resolved
allow-list entries (two attribution gaps, two undo gaps and two missing-link
failures) were removed; the brief counted four.

Headless agent-browser drove real HTTP undo, idempotent receipt replay, reload,
restore and a 390px mobile overflow check in both themes. The browser used an
isolated worktree session and never opened a visible window. The generic store
journal replay checks cover retained undo and attribution; real DB runs belong
in CI. Two DB-dependent targeted tests skip without their configured DB.

Screenshots compared with the approved artboards:

- [Dark attribution](rp/screenshots/dark/B11-quill.png)
- [Light attribution](rp/screenshots/light/B11-quill.png)
- [Dark admission](rp/screenshots/dark/B21-done-hana.png)
- [Light admission](rp/screenshots/light/B21-done-hana.png)
- [Dark confirmed undo](rp/screenshots/dark/undo-confirmed.png)
- [Light confirmed undo](rp/screenshots/light/undo-confirmed.png)

Reproducible capture outputs: `.runtime/rp-contracts/` (snapshots, independent
contract checks and visual measurements) and `.runtime/rp-interactions/`
(admitted, undone, reloaded and restored screenshots/accessibility snapshots).

The full suite and all screen contracts run in CI; no whole-repo local suite,
live-provider evaluation, deployment or merge is claimed here.
