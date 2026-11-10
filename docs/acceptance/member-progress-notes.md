# Member progress notes: fixture evidence

The member authors bounded narrative content through the existing plan/worker
responses and step-progress commands. Host state, structured counts, time,
checking and acceptance remain separate. No real model/provider/DB run is claimed.
The public design and producer instructions are in
[member-progress-notes](../architecture/member-progress-notes.md).

## Verification

- Added failing tests before implementing bounded declarations, plan notes,
  duplicate progress commands, real start/completion boundaries and original
  result unwrapping. Tested malformed envelopes, unknown effects, wrong actors,
  portable journal replay and clearing an earlier note at an unannotated boundary.
- Related runtime, steering/continuation, telemetry, card, table and DOM tests
  cover the existing drain, feed replacement and delayed-response boundaries.
  New checks verify inert rendering and host counters beside narrative captions.
- Headless `agent-browser` captured the 19 affected screens in both themes;
  token/region comparisons reported no new geometry/token failures. Existing
  B15 drift remains in its pre-existing allowances. The five Representative
  counter screens were captured again after preserving their host step counts.
- `verify-result-facts.mjs` walked active, waiting, failed and completed contexts
  in both themes: compact/expanded panes, result disclosures, keyboard toggle,
  mobile overflow and close. All ten screen/theme journeys passed with zero
  application commands. This checks fixture behavior, not live agents.
- Compared the generated B7-churn dark and B7-fail light pairs with the approved
  artboards. Notes and check captions now appear; the existing transcript/activity
  order differs as recorded below. No approved contract or prototype was edited.

Representative screenshots from these runs:

- [Active progress](member-progress-notes/active-dark.png)
- [Failed check](member-progress-notes/failed-light.png)
- [Mobile failed check](member-progress-notes/failed-mobile.png)
- [Expanded detail](member-progress-notes/expanded-dark.png)

Full local captures are in `.runtime/member-progress-contracts/` and
`.runtime/member-progress-counter-contracts/`; interaction evidence is in
`.runtime/member-progress-interactions/`.

## Copy audit

One source-free term table governs new wording. Fixed labels and conversational
content use distinct grammatical forms. `확인 대기` means independent checking;
`결정 대기` means an owner decision. `실행 취소` undoes an action; `되돌리기`
restores a version. They are different concepts, not interchangeable synonyms.

The unpinned approval label now uses `승인됨 · 미실행`. Pinned checking contexts
that use generic `실패`, and procedure confirmations sharing `확인 대기`, are
listed for owner consideration in the PR. The existing `완료` term is consistent;
no standalone `끝남` or `승인 대기` catalog entry was found. Full candidate audit
and source citations stay private; no private app report is copied here.

## Remaining

Of the original 60 allowances, 52 missing-text diagnostics are resolved. Sixteen
are narrowed to existing ordering differences; eight original non-text gaps
remain, for 24 residual entries (net reduction: 36).

The new producer resolves narrative/caption absence. Some contracts still report
an order difference: the existing member transcript places the second Work card
before intervening replies; the activity view places completed file reads ahead
of ongoing Work. These are narrowly retained ordering allowances, not missing
content or an assertion that business prose cannot be produced.

The single-step payment fixture has no member procedure progress note declaring
an order-history caption. Browser/page-read observations and unrelated time/count
ordering are not produced by adding narrative content and remain explicit gaps.
No narrative is treated as browser telemetry, a payment receipt or acceptance.

## Local credential safety

Read the lead's updated prohibition. Audited tests, scripts and desktop scripts
for real `security`, `op`, OS automation and privileged execution paths. Existing
Keychain tests use injected fake runners; no real vault command was run locally.
Linux CI setup commands in workflows were not executed on this Mac. Real Keychain
behavior was not tested; this change does not touch secret/vault implementation.
