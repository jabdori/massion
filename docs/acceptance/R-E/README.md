# R-E acceptance evidence

This slice adds owner-created schedule templates, accepted static PDF/PNG results and exact GitHub review context. Evidence uses fixture providers and loopback hosts; no external models, GitHub requests or payments were made.

## Passed

- Node v24.21.0 typecheck and `git diff --check`.
- Related regression run: 229 passed, zero failed, 12 skipped. The skipped cases are existing real-DB cases and the documented local Turkish-locale inventory case. The affected schedule/client set passed again (30 tests) after the create/feed race was reproduced and fixed; the explicit binary-backup refusal test also passed.
- B10, B17, B17-empty and B22: **168/168** required elements passed across dark and light, with zero contract, visual, gap or harness errors. [Machine-readable report](contracts.json).
- Removed exactly **34** resolved allow-list entries in `Other schedule kinds`, `Non-text results`, and `GitHub external URL, commits and review binding`. No exceptions were added.
- Browser interactions against the normal loopback host: create a month-end schedule, observe its stored identity, pause and resume; select PR #84, switch to #83 and back, open the current Work's PR tab and attach the exact repository/PR/head source using the existing owner commands. [Schedule receipt](native-flows.json), [GitHub receipt](github-native-flow.json).
- Real PNG decoding at 96x32 and inert PDF page text extracted from the verified file bytes, with Original links to the same binary data, were observed in headless Chrome.

## Screenshots

- Contract pages: [B10 dark](screenshots/dark/B10.png), [B17 dark](screenshots/dark/B17.png), [B17-empty dark](screenshots/dark/B17-empty.png), [B22 dark](screenshots/dark/B22.png); matching light captures are in `screenshots/light/`.
- Result previews: [PNG](png-preview.png), [PDF](pdf-preview.png).
- Normal owner flows: [schedule form](schedule-create.png), [stored schedule](schedule-persisted.png), [exact GitHub source attached](github-source-bound.png).

## Limits and remaining checks

CI owns the full suite and the complete blocking screen gate. The unchanged B10-preview member-composer/pane-budget residuals and B22-room procedure/composer residuals remain on the existing allow-list.

The portable backup format remains text-only and explicitly rejects a Mission containing binary results instead of silently omitting files. Binary backup/restore requires a follow-up format migration. PDF support is the static printable-ASCII subset; PNG is bounded non-interlaced RGB. PDF preview draws the decoded static text, while Original preserves the actual PDF bytes. Schedule times retain the existing fixed UTC-offset/DST limit. GitHub retains the existing single repository and bounded first-page reads. Live-provider, real-GitHub and real-DB execution were not run locally.

Local test logs: `/private/tmp/re-final-related.txt`, `/private/tmp/re-schedule-panel-final.txt`, `/private/tmp/re-contracts-final.txt`. The earlier portable regression run reproduced the already documented macOS Turkish-locale directory-realpath failure; it was not changed by this slice.

## Review regressions

The independent review's binary-first storage failure was reproduced: a nested binary directory could precede the parent text ownership marker. The normal runtime now initializes the existing text store before its first binary write; a binary-first then text-write regression passes. Confirmed GitHub capture/attachment rejections release their private binding lock for an explicit owner retry, while unresolved outcomes retain the lock. The same client test covers both rejection stages and lost receipts.

UTC schedule request assertions normalize JSON's `-0` to `0`. The current Work-scoped PR tab identity is reflected in the fixture interaction. Long commit messages keep their complete title for accessibility/hover while their displayed line remains within the existing pane text budget. The affected run passed 72 tests with three existing real-DB skips; typecheck passed.

Multi-step member PDF and PNG runs now retain hash-checked original bytes in the room evidence, so their review projection is never compared as though it were the file's byte stream. End-to-end fixture tests pass both formats through the actual member procedure, challenge, independent verifier and accepted Record. Late confirmed schedule replies preserve their original source without resending, while owner-closed runs remain closed. The affected UTC run passed 162 tests with three existing real-DB skips; typecheck and a fresh workbench import passed.

The final review follow-up keeps answered turns with missing admission outcomes, and missing/failed authoritative source reads, unknown rather than enabling Retry. Commit subjects are bounded before app-view validation, including Unicode surrogate boundaries. A delayed page refresh cannot reverse a newer PR selection; automatic review refresh is scoped to GitHub. All four regressions were observed failing before their fixes. The affected UTC run passed 68 tests with no skips or failures; typecheck passed.

## Authorized final scope extension

The ordinary-Mission P2 is fixed by traversing the existing host Mission catalog, including later pages, before reading exact Work source pins. This is independent of Representative conversation lineage. The normal Surreal host provides the catalog; compatibility hosts without that optional port retain the prior conversation/intake fallback. Regression coverage includes an ordinary Mission on page two, feed/cursor changes, both page/item HTTP views, and events from a Mission absent from the conversation. Such events refresh the visible review without submitting owner commands.

The B17-empty cards now use the six original geometric icons and separate title/description elements. B22 and the PR room tab share a bordered top-right external action with the external-link glyph and PR meta icon. The review strip uses the busy dots, separated metadata and chevron, with accessible status adjacent to the navigation control; no duplicate status label or sidebar text line is painted. The room title keeps its PR number on one line, and file deltas use the same numeric presentation as the main app page.

Head-bound GitHub CI results and per-file read receipts remain unavailable in this branch. No `verify 통과`, read markers or per-member file-read count is invented: [check status evidence](../E3d2/review-follow-up.md#missing-check-status-a16) and [file-read evidence](../room-residuals/README.md#r-e-visual-follow-up-filecheck-data-boundary) record the current source shape and the unmerged R-A dependency.

After merging PR #117, the affected runtime/monthly-budget/catalog/app/schedule/copy suites passed **194 tests**, with three existing real-DB skips and no failures; typecheck passed. The merge retained both the binary-output and monthly-budget runtime tests. The [final two-theme structure captures](visual-followup/report.md) contain B17-empty, B22 and B22-room. B17-empty and B22 pass every required element; B22-room retains only the six existing unsupported procedure/file-read occurrences and the existing composer geometry residual. No new allow-list exceptions were added. The mechanical detector reported no findings; rendered screenshots were inspected separately.
