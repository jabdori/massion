# R-I: honest app recommendation availability

This is the B23 catalog slice of R-I, above `80672ac`. The host now produces all
six recommendation rows with `available: false`, explicit `패키지 없음` text and
disabled native install buttons without handlers. GitHub remains the only bundled
executable package and uses the existing owner decision path. Direct install
requests for any unavailable recommendation fail without writing state or a
decision. No package, version, permission grant or install success is fabricated.

## Removed exceptions

Removed **14** entries from `scripts/ui-contracts/allow-list.json`: one missing
recommendation heading and six missing install-control roles in each theme.
The contract checker accepts the existing button/link equivalence, including
disabled native buttons; this proves row/control fidelity, not installability.
The catalog change removes **14** diagnostic identities without adding any.
It initially reduced the list from 426 to 412 above `80672ac`; after merging
`9422008`, which adds two upstream B7 residuals, the list is **428 to 414**
relative to current main. Those upstream Work-room changes are outside this slice.

The B23 capability gap remains in both themes because the six apps still have no
executable packages. Its reason now distinguishes available display metadata from
unavailable install authority. The fixture keeps the original gap identity so the
shrink-only gate cannot hide the missing packages.

## Verification

- New service test failed before implementation, then passed. It covers actual
  catalog projections, all six direct install refusals, unchanged journal and
  decision state, and GitHub's real install decision.
- Node 24 focused app runtime/surface/visual tests passed (58 tests); the final
  surface, fixture and copy run passed 43 tests. Static typecheck passed.
- CI exposed one older app-lifecycle fixture assertion that still expected a
  one-entry catalog. Reproduced locally, then updated it to require one installed
  executable package and six unavailable, uninstalled recommendations.
- Copy lint: zero findings. Impeccable detector: zero findings on `apps-panel.ts`.
- Headless B23 capture: **29/29** required elements in each theme, zero contract,
  visual or infrastructure failures. The intentionally retained package gap is
  reported, so the report-only aggregate does not claim full capability coverage.
- Compared prototype/workbench PNG pairs in both themes. Existing layout, theme
  tokens, installed/self-made rows and counts are retained.
- Headless interaction evidence covers searching Slack, no-match/clear, opening
  installed GitHub details and returning to the six unavailable recommendations.
  No outside provider or model calls are made.

Evidence: [capture report](catalog/report.md),
[dark comparison](catalog/pairs/dark/B23.png),
[light comparison](catalog/pairs/light/B23.png),
[interaction report](interaction/report.json),
[Slack search](interaction/search-slack.png),
[GitHub detail](interaction/github-detail.png).

## Follow-up

- Real packages for Slack, Linear, Google Calendar, Notion, Figma and Sentry need
  their own package permissions, sandbox checks and owner install decisions.
- Member builtin skill provenance, member-bound memory reads/removal and schedules.
- Typed token-expiry facts and exact identity-bound credential repair/retry.
- Native pending-restart/installed-version/notification state and restart executor;
  update download, signing and publishing remain owner-only and out of scope.

Work panes, rooms, steering, browser runtime and the app-frame e2e flake are owned
by parallel agents and are not changed by this slice. Local full-suite and all-75
contract execution are delegated to CI under the requested verification budget.
