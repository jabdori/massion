# App settings visual corrections

Scope: `src/apps-panel.ts`, `tests/apps-surface.test.ts` and
`tests/app-settings-visual.test.ts`. B23 contracts,
prototype artboards and the existing settings button styles remain authoritative.

- Remove the unsupported member checkbox editor, including its save button.
  Keep backend member bindings and their read-only contribution labels.
- Offer reconnect only for an expired or missing credential. Reuse `secondary`
  button styling so foreground, background and border follow both theme palettes.
  Keep lifecycle locking, feed/selection fencing and unknown-outcome protection.
- Render versions only when the host supplies approved history. Rollback uses
  the host's version index and the existing owner command path. `AppsService.read()`
  supplies approved versions; a single approved version supplies no rollback target.
  No history means no version section or invented version/rollback action.
- Recommend only uninstalled entries from the host catalog. `CATALOG` contains
  only GitHub. When installed, it leaves no recommendations. Slack, Linear,
  Google Calendar, Notion, Figma and Sentry have no installable packages; retain
  `docs/acceptance/rc/README.md#remaining` and the existing allow-list entries.

All labels already exist in `copy.ko.json`; no new copy keys are required.
Verification is focused tests and typecheck. The main agent owns browser captures.

The browser procedure now seeds bindings through the actual owner command and
checks their read-only display. It also measures the reconnect button contrast in
both themes before entering the existing masked token flow.
