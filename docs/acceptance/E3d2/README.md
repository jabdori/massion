# E3d2 page fidelity

After integrating merged E3c (`d435690`), required matches are **354 → 466 / 576**, contract diagnostics **228 → 112**, geometry/palette diagnostics **14 → 4**, infrastructure errors **0 → 0** across ten states in both themes. This is not a claim of complete pixel or business-workflow fidelity.

[Baseline classification](baseline-classification.md) · [Before](before.json) · [After](after.json) · [Full 150 runs](full150.json) · [Execution receipt](full150-execution.json) · [Residual ledger](residuals.md) · [Producer evidence](capabilities.md) · [Verification](verification.json) · [Independent review corrections](review.md)

| Screen | Before matches | After matches | Diagnostics before → after | Dark artboard / app | Light artboard / app |
| --- | ---: | ---: | ---: | --- | --- |
| B9 | 52/74 | 64/74 | 22 → 10 | [PNG](pairs/dark/B9.png) | [PNG](pairs/light/B9.png) |
| B9-restart | 52/76 | 64/76 | 24 → 12 | [PNG](pairs/dark/B9-restart.png) | [PNG](pairs/light/B9-restart.png) |
| B9-update | 52/74 | 64/74 | 22 → 10 | [PNG](pairs/dark/B9-update.png) | [PNG](pairs/light/B9-update.png) |
| B10 | 32/52 | 46/52 | 20 → 6 | [PNG](pairs/dark/B10.png) | [PNG](pairs/light/B10.png) |
| B10-preview | 44/62 | 60/62 | 20 → 4 | [PNG](pairs/dark/B10-preview.png) | [PNG](pairs/light/B10-preview.png) |
| B12 | 26/52 | 42/52 | 26 → 10 | [PNG](pairs/dark/B12.png) | [PNG](pairs/light/B12.png) |
| B15 | 36/70 | 38/70 | 34 → 32 | [PNG](pairs/dark/B15.png) | [PNG](pairs/light/B15.png) |
| B17 | 24/46 | 40/46 | 24 → 6 | [PNG](pairs/dark/B17.png) | [PNG](pairs/light/B17.png) |
| B17-empty | 14/30 | 20/30 | 16 → 10 | [PNG](pairs/dark/B17-empty.png) | [PNG](pairs/light/B17-empty.png) |
| B22 | 22/40 | 28/40 | 20 → 12 | [PNG](pairs/dark/B22.png) | [PNG](pairs/light/B22.png) |

## Implementation and integrity

Existing Results/Schedules/Memory/GitHub renderers use keyed copy and generated tokens. Local search, validated Representative-source result navigation with assignee display, original/preview modes, profile navigation and request copy reuse existing host paths. The stored schedule run segment now survives its existing read projection. Singleton, cumulative-budget, unknown-outcome, command identity and drain-aware boundaries remain. No new write API or dependency is added.

B22 views are generated from the original immutable package using `runHandler` and `githubFixture`, including all eleven available files. Accepted fixture Records and artifact responses retain their original checksums/bytes. B15 includes supported unrelated Quill activity without manufacturing library browser state. Contracts/artboards are unchanged. The Settings-main region and visible-page budget classification corrections have regression coverage; order/occurrence/budget and fatal infrastructure rules are preserved.

## Verification

- Exact CI screen command: all 75 contracts × both themes, 150 captures, exit 0, infrastructure errors 0. Contract drift remains report-only and is fully recorded.
- Typecheck, source checks and copy lint passed; generated tokens are current.
- Focused client/host and fixture tests: 100 passed, including the independent-review source-thread and persistent-filter regressions.
- Exact CI `npm run check` on the final review candidate with `TZ=UTC`, Node 24.21 and a physical temporary directory: 1,591 passed, 340 skipped, one documented local portable-inventory English/Turkish-locale realpath failure. No storage/runtime guard was changed.
- [Native browser checks](native-interactions.json): eight both-theme desktop cases passed using [the page verifier](../../../scripts/ui-contracts/verify-pages.mjs). Query survives a conversation read, actual app removal retains live search/navigation, and the schedule switch measures 34×20 with a 16px knob and white light-theme ink.
- Fixtures additionally exercise Results query/clear, accepted original/preview modes, memory query/clear, schedule budget disclosure and singleton selection, and GitHub merged-group/search interactions without product writes.

Twenty checked-in pairs show artboard left and app right. Missing typed artifacts, named business facts, browser/device lifecycle, unsupported schedule kinds, exact memory source/name and app URL/commits/review binding are recorded in the ledger. Real-provider, payment, live GitHub, browser submission and external database integration are not established by these fixtures. E3 remains open.

## PR 110 follow-up

[CI timezone fix, A1–A16 checklist and both independent GLM findings](review-follow-up.md). Results open the actual Representative source segment and originating turn, preserving the assignee only on the row; schedule filters survive redraws. The corrected source route explains the retained B10-preview member-composer mismatch. The host supplies no PR check status, so `verify 통과` is not manufactured.
