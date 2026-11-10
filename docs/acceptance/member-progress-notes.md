# Member progress notes: fixture evidence

See the [required design and vocabulary](../architecture/member-progress-notes.md).
Typecheck, 339 related tests, two targeted runtime cases and 48 final affected
fixture tests passed. All model/provider responses were fixtures. Portable replay,
assignment/unknown fences, duplicate commands, real step boundaries, inert text,
stale-note clearing and host counters were exercised. No real vault command ran.

Headless checks covered changed screens in both themes; ten interaction journeys
covered compact/expanded panes, keyboard disclosures, mobile overflow and close,
with zero commands. Compared active/failed pairs against the approved artboards:
[active dark](member-progress-notes/active-dark.png),
[active light](member-progress-notes/active-light.png),
[failed dark](member-progress-notes/failed-dark.png),
[failed light](member-progress-notes/failed-light.png).

## Remaining

The original 60 allowances become 24: 52 missing-text diagnostics resolved,
16 narrowed to existing transcript/activity ordering, eight original gaps retained.
The latter cover a single-step payment order-history caption without a declared
member-step note, browser telemetry and unrelated pane time/count ordering.
Narrative is never a payment receipt, browser observation or accepted evidence.
Approved contracts/prototypes remain unchanged; pinned vocabulary proposals are
in the PR. Full-suite and aggregate screen-gate results belong to CI.

R-Y removes the eight activity-order allowances and the two B16-sent link-order
allowances by preserving the proposal's unread marker during fixture setup.
Completed reads already follow ongoing Work; no row ordering change is needed.
The eight transcript allowances remain: the stored second handoff precedes the
member reply and steering exchange. Matching the later approved placement needs
an owner decision on fixture chronology, not a screen-specific ordering rule.
