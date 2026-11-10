# Polish batch 2 evidence

Baseline: main `e15b9c0`. Before captures use an untouched `git archive` of that
commit; after captures use this branch. All browser sessions are isolated,
headless agent-browser sessions with the production workbench and existing
production-derived screen fixtures. Fixture time is fixed to the host fixture
clock. No real model, provider, device, payment, credential or external effect was
invoked. Screenshots are fixture UI evidence, not live integration evidence.

## Scope and result

| Brief item | Result |
| --- | --- |
| 1. General | Notification saves show `설정 저장 중` in a live status subline and mark the row busy until settlement. The restart status uses the UI font, with an extra existing spacing token before its action. The unconfigured briefing uses the existing `없음` label. Unknown native notification/version facts still use `—`. |
| 2. Apps | Unavailable install controls use a muted disabled foreground, border and opacity in both themes. Package availability hints use the secondary hint token, below app-name emphasis. No catalog change. |
| 3. Table | Work room table captions align with their sender row. The scrolling pane has a thin contrasting scrollbar and a shadow above the sticky check bar to signal clipped table content. Scrolling reveals the remaining real table rows. |
| 4. Check | A checking row shows `맞음` or `아님` once. Expanded rows no longer pair a lifecycle label with the same verdict, and compact checking rows no longer repeat the header count. The header retains its check count. |
| 5. Failed evidence | Already fixed on main: the bound current verdict supplies the red right-hand detail. This fixture actually says `해지 사유 7건 누락`; it does not establish a threshold of three grounds. No prototype threshold is invented. |
| 6. Expanded header/flow | Already fixed on main: expanded panes show the collapse glyph without a selected fill. Each stored worker event time is rendered; absent times remain absent. Checked against each task's real start/end timestamp. |
| 7. Member | Procedure labels use the UI font rather than the later monospace chip override. The archive line uses the card's horizontal inset. |
| 8. Mobile | Korean Work pane text keeps words together with a fallback for long unbroken result bytes. Connection labels use the UI font and normal tracking instead of monospace spacing. Verified at 390 px. |
| 9. Credentials | Already fixed on main: invalid credentials use `인증 실패`; expired credentials use `만료됨`. Settings connections and app token rows select the matching typed status. Existing credential repair tests pass; no label rewrite or expiry inference. |

## Captures and interactions

Each file below has both `dark-` and `light-` variants in [before](before/) and
[after](after/). Matching `.txt` files retain accessibility roles and names.

- `B13-general.png`, `B13-general-restart.png`: ordinary and restart-required General.
- `general-saving.png`, `general-saved.png`: change notifications, hold the existing
  native bridge response, inspect disabled select/busy row/live status, resolve it,
  and verify the saved value and restart action without resubmission.
- `B23.png`, `apps-unavailable.png`: unavailable packages stay disabled; measured
  disabled text differs from app names, with opacity 0.48 in both themes.
- `B18-room-b.png`, `table-cut.png`, `table-scrolled.png`: compare sender/caption
  left edges (within 1 px), inspect the bottom cue and scroll to the final rows.
- `B8-done.png`, `B8-fail.png`, `B8-done-details.png`, `B8-fail-details.png`,
  `B7-fail-details.png`: one verdict per checking row, current bound failure
  evidence, collapse glyph, and stored flow times.
- `B19-juno.png`, `member-procedure-archive.png`: computed procedure font matches
  the UI font; archive text aligns with the card content to within 1 px.
- `B7-unknown.png`, `B7-unknown-mobile.png`, `B8-fail-mobile.png`: unknown outcome
  remains unknown, no horizontal overflow, Korean word boundaries and normal
  tracking. Mobile setup follows the real desktop navigation before resizing.

Browser assertion output is retained in
[before measurements](before/interaction-measurements.json) and
[after measurements](after/interaction-measurements.json). Compared rendered
pairs with the approved artboards for General, Apps, Work and Member screens.
The one mechanical design scan of the changed source returned no findings.

## Verification

On Node 24.21.0 with `TMPDIR=/private/tmp`:

```sh
node --test tests/device-lifecycle-surface.test.ts tests/work-room-visual.test.ts tests/settings-visual-structure.test.ts tests/settings-surface.test.ts tests/app-settings-visual.test.ts tests/token-expiry-repair.test.ts tests/ui-contract-fixtures.test.ts tests/ui-contract-gate.test.ts tests/ui-copy-lint.test.ts
npm run typecheck
```

119 focused tests pass; typecheck passes. New/expanded behavior assertions were
observed failing before the implementation. Earlier exploratory runs used the
machine default Node 26; the final focused run uses the supported Node 24 line.

The focused contract runner covered B13-general, B13-general-restart, B23,
B18-room-b, B8-done, B8-fail, B7-unknown and B19-juno in both themes.
[Before results](before/contracts-report.json) and
[after results](after/contracts-report.json) retain the diagnostics. All four
General captures now pass every required element. Other selected captures have
no new diagnostic identities; their existing capabilities remain on the allow-list.

The General contract's obsolete installed-version dash is now the ordinary
content slot, matching its existing real desktop producer and unit assertion.
Its descriptive briefing option text follows the owner's unset-label correction.
Four installed-version exceptions were removed; none were added. Full source,
unit, durable-store, install and all-screen checks belong to PR CI under the
owner's verification budget. CI/current-head Codex status is reported on the PR.

## Remaining

Browser/payment producers, business thresholds absent from actual evidence,
missing historical timestamps and other existing capability residuals remain
outside this polish batch. No unavailable app becomes installable, no notification
save is resent, and no unknown outcome becomes success. The lead owns independent
review and merge approval.
