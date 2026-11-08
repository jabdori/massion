# Candidate verification

- Node: 24.21.0. `TMPDIR` was the physical macOS scratch directory required by the repository brief.
- `npm run check`: **1,451 passed, 1 failed, 340 skipped** (1,792 tests).
  Type checking, runtime syntax checking, generated-token drift checking and copy
  lint all passed. Copy lint found **0 findings in 27 files**.
- The sole failure is the already documented `portable inventory order is stable
  across English and Turkish process locales` test: `Text artifact boundary:
  directory realpath mismatch`. A targeted run against the untouched baseline
  commit `dc5a93a` reproduced the same failure under the same Node/TMPDIR setup.
  No test was skipped or weakened to hide it.
- Final focused UI checks passed. In particular the five offline regressions
  cover exact original command/target replay, no automatic sends, retained drafts
  and reconnect locks, stale callbacks after thread changes/edits, and editing
  during an in-flight send whose response is lost.
- Independent read-only review identified the two stale-resend cases. Both were
  reproduced as failing regressions, fixed, and rechecked by the reviewer.
- Browser runner: 75 baseline screens × 2 themes, 75 candidate screens × 2
  themes, plus final affected-state recaptures. No infrastructure errors; all
  26 semantic palette roles match in both candidate themes. Geometry/semantic
  contract drift remains report-only and is listed per screen in `counts.md`.
- B2, B2-offline and B2-offline-failed were recaptured after the visual corrections in
  `.runtime/e3a-visual-fix/`. Other final captures are in
  `.runtime/e3a-final/`; the original Node 24 snapshot is in
  `.runtime/e3a-before-node24/`. Each has snapshots, checks, screenshots, visual
  measurements, pairs and JSON/Markdown reports.

The 340 skips retain their original environment gates. Actual SurrealDB,
provider, external app, native-client and persistent recovery effects were not
established by the fixture evidence. The Work pane, composer and card layouts
remain for later E3 slices.

Visual follow-up: [34 affected-state captures](visual-rerun.json), [direct browser style/position checks](visual-details.json), and [review notes](visual-followup.md). The final member-dialog border received 18 passing focused tests plus both-theme B21-name captures after the aggregate run.
