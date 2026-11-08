# E3b conversation evidence

Measured above E3a (`1595710`) using the repository's isolated **headless agent-browser** runner, the same 22 fixture states and both browser system themes. Contracts, approved copy and visual tokens were not changed. No provider, database or product write was used. This is fixture evidence, not proof of external effects or complete artboard fidelity.

## Result

| Measurement across 44 captures | Before | After |
| --- | ---: | ---: |
| Required elements matched | 504 | 764 |
| Contract failures (including order and budgets) | 596 | 370 |
| Geometry/palette failures | 42 | 0 |
| Infrastructure errors | 0 | 0 |

[Before report](before.json), [after report](after.json), [before visual measurements](before-visual.json), [after visual measurements](after-visual.json), [remaining contract failures](after-failures.md). Failures are not `required - passed`: forbidden/budget/order checks are separate. The runner remains report-only. **This PR does not make every E3b contract pass.**

## Verification

- Node 24.21.0 (within package.json's supported 24.19–24.x range), the existing installed dependencies and the brief's physical macOS TMPDIR.
- `npm run typecheck`: passed.
- `node scripts/check.mjs`: passed; copy lint 0 findings, generated tokens current, runtime syntax passed.
- `npm test`: 1,821 tests: 1,480 passed, 340 skipped, one failed: `portable inventory order is stable across English and Turkish process locales`. The brief names this known macOS failure; no inventory implementation changed. Database/provider-dependent skipped tests were not run against real services.
- Existing command-overlap, ownerStore draining, database replacement, deadline refresh and stale generation tests retained. Added clipboard-generation, draft-preserving member selection, scroll anchoring/unread, failed-answer draft retry, assigned-stage progress and narrow workspace toggle coverage. Unknown Work/delivery paths never get a new retry or resend.
- Separate browser assertions in both themes: editor 200px cap with 770px content scroll height, shrink to 22px, 680px column, 20px radius, token 2px focus ring, mention arrows/Escape/Enter, retained source draft, sidebar search/Escape, header menu/focus return, unread jump, and one-click workspace reopening after navigation at 800px. [Measurements](interactions.json).
- Independent final diff review found the narrow-screen workspace toggle defect. A failing regression test was added, the visible-state calculation fixed, and both-theme browser interactions confirmed the correction. The 44 artboard captures use desktop viewports; their candidate differs from the final source only by this separately verified narrow-screen visibility correction.
- Impeccable mechanical detector: no findings on the changed panel/shell. `git diff --check`: passed.

Runner command (both before and after, with `UI_CONTRACTS_OUTPUT=.runtime/e3b-before` or `.runtime/e3b-after`):

```sh
node scripts/ui-contracts/run.mjs B1 B2 B2-offline B2-offline-failed B3 B3-run B4 B5 B6 B6-token B11 B11-quill B16 B16-later B16-sent B18 B21 B21-name B21-done B21-done-hana B26 B26-later
```

Full local snapshots/screenshots/checks remain in the two output directories. Committed pairs below are the exact runner output, approved reference on the left and implementation on the right. They were inspected in both themes.

## Requested pairs

| Screen | Dark before | Dark after | Light before | Light after |
| --- | --- | --- | --- | --- |
| B2 | [PNG](pairs/before/dark/B2.png) | [PNG](pairs/after/dark/B2.png) | [PNG](pairs/before/light/B2.png) | [PNG](pairs/after/light/B2.png) |
| B5 | [PNG](pairs/before/dark/B5.png) | [PNG](pairs/after/dark/B5.png) | [PNG](pairs/before/light/B5.png) | [PNG](pairs/after/light/B5.png) |
| B11 | [PNG](pairs/before/dark/B11.png) | [PNG](pairs/after/dark/B11.png) | [PNG](pairs/before/light/B11.png) | [PNG](pairs/after/light/B11.png) |
| B18 | [PNG](pairs/before/dark/B18.png) | [PNG](pairs/after/dark/B18.png) | [PNG](pairs/before/light/B18.png) | [PNG](pairs/after/light/B18.png) |

## Remaining scope and limits

- B7 Work-pane structure and later pages were not redesigned; the header only toggles the existing pane and preserves its tabs.
- The file-add control is present but disabled: the message API has no attachment transport. No upload or arbitrary file-to-message conversion was invented.
- The approved copy table has no `맨 아래로` or `답` summary key. The jump uses existing `ui.latest` (`최근 대화`); progress uses approved `만들기` and `확인` with host-derived assigned child-task counts. No unapproved copy key was added. Current screen fixtures carry only the old generic step totals, so their cards retain those truthful totals rather than infer role counts. Production reads now also expose assigned make/check counts.
- Existing safe unknown-outcome actions are retained. B5 therefore has read-back `확인`, not a fabricated order-inspection API or a new Close action. The existing folded line has no duration until the host has an actual end time; none is fabricated for an ongoing unknown effect.
- Prototype states that need case-detail links, device inspection, budget-waiting/increase semantics, memory-candidate save/discard or Representative-thread member attribution still need their host/product paths. Existing fixture gap annotations for these remain. B11's old “no mention autocomplete” annotation is stale: the new listbox and keyboard selection are verified separately; no fixture responses were changed to improve counts.
- Several fixtures intentionally have different timestamps, histories, reply text, app rows and role data from the artboards. The renderer uses those stored facts, so order/content/type-role budget differences remain visible in the raw failures. No fake role chips, timestamps, elapsed durations or successful effects were added to match example sentences.
- Clipboard rejection uses the existing unavailable status copy. Clipboard writes use the browser API and are handled without automatic retries ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)); a late rejection cannot modify a newer conversation generation.

## Per-screen measurements

`matched / failed`, with geometry/palette failure counts shown separately.

| Screen | Theme | Before | After | Visual |
| --- | --- | ---: | ---: | ---: |
| B1 | dark | 6 / 6 | 9 / 3 | 1 → 0 |
| B2 | dark | 13 / 19 | 24 / 9 | 1 → 0 |
| B2-offline | dark | 14 / 6 | 17 / 4 | 1 → 0 |
| B2-offline-failed | dark | 13 / 9 | 18 / 5 | 1 → 0 |
| B3 | dark | 13 / 10 | 19 / 4 | 1 → 0 |
| B3-run | dark | 13 / 11 | 19 / 5 | 1 → 0 |
| B4 | dark | 13 / 26 | 21 / 19 | 1 → 0 |
| B5 | dark | 6 / 12 | 11 / 7 | 1 → 0 |
| B6 | dark | 12 / 23 | 17 / 19 | 1 → 0 |
| B6-token | dark | 13 / 16 | 17 / 13 | 1 → 0 |
| B11 | dark | 9 / 13 | 17 / 7 | 0 → 0 |
| B11-quill | dark | 10 / 8 | 16 / 4 | 1 → 0 |
| B16 | dark | 11 / 12 | 18 / 5 | 1 → 0 |
| B16-later | dark | 11 / 11 | 17 / 5 | 1 → 0 |
| B16-sent | dark | 10 / 12 | 16 / 6 | 1 → 0 |
| B18 | dark | 12 / 22 | 19 / 17 | 1 → 0 |
| B21 | dark | 11 / 11 | 18 / 5 | 1 → 0 |
| B21-name | dark | 15 / 19 | 22 / 13 | 1 → 0 |
| B21-done | dark | 13 / 7 | 17 / 4 | 1 → 0 |
| B21-done-hana | dark | 12 / 11 | 18 / 5 | 1 → 0 |
| B26 | dark | 11 / 17 | 17 / 12 | 1 → 0 |
| B26-later | dark | 11 / 17 | 15 / 14 | 1 → 0 |
| B1 | light | 6 / 6 | 9 / 3 | 1 → 0 |
| B2 | light | 13 / 19 | 24 / 9 | 1 → 0 |
| B2-offline | light | 14 / 6 | 17 / 4 | 1 → 0 |
| B2-offline-failed | light | 13 / 9 | 18 / 5 | 1 → 0 |
| B3 | light | 13 / 10 | 19 / 4 | 1 → 0 |
| B3-run | light | 13 / 11 | 19 / 5 | 1 → 0 |
| B4 | light | 13 / 26 | 21 / 19 | 1 → 0 |
| B5 | light | 6 / 12 | 11 / 7 | 1 → 0 |
| B6 | light | 12 / 23 | 17 / 19 | 1 → 0 |
| B6-token | light | 13 / 16 | 17 / 13 | 1 → 0 |
| B11 | light | 9 / 13 | 17 / 7 | 0 → 0 |
| B11-quill | light | 10 / 8 | 16 / 4 | 1 → 0 |
| B16 | light | 11 / 12 | 18 / 5 | 1 → 0 |
| B16-later | light | 11 / 11 | 17 / 5 | 1 → 0 |
| B16-sent | light | 10 / 12 | 16 / 6 | 1 → 0 |
| B18 | light | 12 / 22 | 19 / 17 | 1 → 0 |
| B21 | light | 11 / 11 | 18 / 5 | 1 → 0 |
| B21-name | light | 15 / 19 | 22 / 13 | 1 → 0 |
| B21-done | light | 13 / 7 | 17 / 4 | 1 → 0 |
| B21-done-hana | light | 12 / 11 | 18 / 5 | 1 → 0 |
| B26 | light | 11 / 17 | 17 / 12 | 1 → 0 |
| B26-later | light | 11 / 17 | 15 / 14 | 1 → 0 |
