# Settings catalog availability (R-I)

## Intent and scope

B23 names six recommended apps whose executable packages do not exist. Show
those host-owned recommendations with an explicit unavailable state. Keep the
bundled package catalog as the sole source of install authority. A name in the
recommendations must never create an install decision, version, permission grant,
network call or installed app.

This PR is the catalog slice of R-I. Member skill provenance, member-bound memory
and schedules, typed token-expiry repair, and native device lifecycle remain
follow-up work. Work panes, rooms, steering and browser runtime are out of scope.

## Implementation and verification plan

1. Add a failing service test for the six unavailable recommendations and direct
   install refusal without journal mutation. Retain the GitHub install decision.
2. Add recommendation descriptors beside the real bundled catalog and project
   their availability from actual package presence in `AppsService.read()`.
3. Render unavailable recommendations with explicit status text and disabled
   native install buttons without handlers in the existing Settings rows.
   Available packages retain the existing install action.
4. Extend production-derived fixture and surface tests. Verify search and both
   themes with the existing headless contract runner, then remove only resolved
   allow-list entries and narrow the remaining package-related reasons.
5. Run focused tests and typecheck, publish the PR, and follow CI and the Codex
   receipt for the final commit. Do not merge.

The existing B23 artboards, copy table, spacing and components are the visual
authority. No new design system or dependency is needed. No external services or
models run in tests. Recommendations contain display metadata only; packaged
source, validation, owner approval, secret handling and execution remain unchanged.
