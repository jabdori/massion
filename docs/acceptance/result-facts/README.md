# R-M: generic ordered result facts

The product understands ordered declared items, not business scenarios. A worker
or final assembly can return exactly
`{"format":"massion-facts/v1","items":[{"label":"Files","value":3,"unit":"items"},{"label":"Phase","value":"Ready"}]}`.
There are 1–8 items: labels up to 64 characters, integer values from zero through
one billion or text up to 96 characters, optional units up to 16 characters, and
4096 UTF-8 bytes total. Keys are exact; strings are trimmed, well-formed single
lines without control/format characters. No scenario kind or migration remains.

The same inert renderer joins items in their declared order. State comes from
actual Work/step status and the original step titles. Neither labels nor titles
are interpreted. Final facts preserve their original artifact/checking bytes and
replace worker declarations in the read projection. Generic tables retain the
original four-key protocol and worker-table count; table rows never invent fact
items. Scenario labels exist only in fixture producer inputs.

## Verification

- The new generic parser and final-assembly cases first failed against the old
  scenario implementation, then passed. Arbitrary labels, numbers/text, declared
  order, invalid keys/bounds/Unicode, literal markup, producer/checker separation,
  overlapping commands and original journal bytes are covered.
- Before main integration: 176 related tests passed. After merging main at
  `8ec8849f5513974b0b36872e800e6c1ab4d5167d`: 192 related result/credential/steering/conversation/fixture
  tests passed with zero failures/skips. These batches overlap and are not summed.
- Typecheck and runtime syntax checks passed; copy lint found zero issues. CI owns
  the full unit/real-database suite and all 75 screen contracts.
- [Scoped capture](report.json): 20 screens in both themes, 216
  retained diagnostics. [Scoped gate](scoped-gate.json) has zero new/stale or
  infrastructure diagnostics after the explicit presentation allowances below.
- `node scripts/ui-contracts/verify-result-facts.mjs`: ten B9/B7-done/B7-fail/
  B8-done/B8-fail flows across dark/light, 1440px and 390px, widen/narrow/close,
  mouse and Enter disclosure toggles, no horizontal overflow and zero product
  commands. [Measurements](interactions/interactions.json) retain actual rendered
  item labels, status, alignment and chevron sizes.
- Screenshots: `interactions/{B9,B7-done,B7-fail,B8-done,B8-fail}-{dark,light}-`
  `{compact,expanded,mobile}.png`. B8 variants additionally have `-flow.png` and
  `-mobile-flow.png`; their snapshots retain actual names and roles.
- Fixtures were regenerated from source. Their scenario data is declared through
  procedure, assigned effect/receipt and settlement commands. The table fixture's
  assembly separately declares its summary after its workers settle. No real
  model/provider, customer data, browser purchase or deployment was exercised.

## Allow-list accounting

[Machine-generated counts](counts.json) compare main `8ec8849f5513974b0b36872e800e6c1ab4d5167d`
(**262 entries**) with the redesign (**266 entries**), a net
**+4**. There is no remaining claim of removing 28 exceptions.

The redesign restores 46 currently observed sentence/card
occurrences with `generic result presentation` reasons and replaces
14 stale ordering identities. Relative to main,
20 diagnostic identities are removed and 24 added;
these include retained gap renames and presentation changes, not a net reduction.
[Exact identities and reasons](remapped.json) and [removed identities](removed.json)
make the accounting reviewable. Every restored allowance corresponds to an actual
capture failure; no contract is weakened or rewritten to fit the renderer.

## Flow visual review

Compared `src/work-room-panel.ts` directly with main `8ec8849f5513974b0b36872e800e6c1ab4d5167d`.
Main already repeats the Work/production/check names in native result disclosures,
and centers the timestamp next to a multiline worker body. This PR touches those
result renderers, so both were fixed here instead of being deferred as polish.

Flow disclosures now say "전체 결과", "작성 결과", "확인 결과" or "결과 보기" and
use the existing chevron icon with native markers hidden. Worker title, member,
role and state share one header aligned with the timestamp. In both themes the
measured maximum worker-title/time top offset is **0px**. B8-done's three
result summaries no longer repeat the Work title or bare step names. Closed/open
and keyboard operation were checked; mobile expanded flow screenshots show the
same layout without horizontal overflow.

## Remaining

The generic output deliberately does not reproduce business-specific prototype
sentences or fixed compound card captions. Literal item values and real state are
available; their presentation differences remain honestly allowed. Producer
observations are never independent checking evidence or an acceptance rule.

Printer browser/payment step clocks and page/order evidence still depend on the
browser producer; file-read evidence belongs to its separate producer. Nothing
copies another Work's timestamps or invents a member/procedure pin. Missing
business-specific checking thresholds remain missing instead of being supplied
by a producer count. Existing unrelated layout and other owners' residuals stay
explicit. The PR remains open for lead re-review; it is not approved or merged.
