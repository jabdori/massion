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


## R-Y classification

All 30 assigned occurrences remain honest owner decisions; no product ordering
rule or fixture history is changed. The 18 ordering reasons now identify their
actual causes rather than a nonexistent file-read priority or missing proposal:

- Eight transcript occurrences: the second stored Work handoff predates the member
  reply and steering exchange. Moving it later needs approved fixture chronology.
- Eight activity occurrences and two B16-sent occurrences: setup opens the real
  rounding proposal and acknowledges its unread marker. The checker then consumes
  a later unrelated marker before finding the required earlier Work/sent row.
  Preserving that proposal unread removes these order diagnostics, but changes the
  switch to `활동 보기, 확인 필요`, while these contracts require `활동 보기`.
  Using the normal name whenever activity is open breaks eight existing B9,
  B9-restart, B9-update and B16 requirements across both themes. The owner needs
  to choose consistent switch-name/unread expectations before these can shrink.
- Six token-screen labels: real stopped, waiting and accepted states cannot be
  represented as running merely to match the original example.
- Two result composers: opening an accepted result preserves its original
  Representative segment rather than an unrelated member conversation.
- Two preview budgets: the exact accepted text and controls use 49 characters
  against a fixed budget of 41; the original result cannot be shortened silently.
- Two single-step payment captions remain with the browser owner's producer;
  no order-history evidence or member step is invented here.

The initial fixture/switch experiment was reverted after full CI exposed the
cross-screen contract conflict. The final diff changes only these explanations;
all 152 diagnostic identities, approved contracts and prototypes are preserved.
