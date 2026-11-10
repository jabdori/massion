# R-L device lifecycle evidence

The desktop producer now supplies installed version, saved notification preference,
and restart-required state. Native save is private and atomic; restart drains the
owned daemon before relaunch. Root and desktop typechecks, the desktop build,
related native/client/fixture tests and scripts/check.mjs passed locally.

Headless interaction evidence (`node scripts/ui-contracts/verify-device-lifecycle.mjs`):
`.runtime/device-lifecycle-interactions/{general,saving,restart-required,devices-pending,general-pending-dark,general-pending-light,restarting,reopened}.png`
and matching `.snapshot.json` files. The production persistence and coordinator
were exercised; the IPC boundary and relaunch callback were fixtures. This is not
evidence of an actual OS relaunch, notification permission or signed release.

The seven R-L screens were captured in dark and light under
`.runtime/device-lifecycle-contracts/screenshots/{dark,light}/`, with accessibility
snapshots, checker results and visual measurements beside them. Device and
connection contracts pass; remaining conversation metadata exceptions predate R-L.
The four General version-dash exceptions deliberately retain the approved contract:
the implementation now displays the installed package version instead of its dash.
No contract, reference artboard or visual token was rewritten to bless the change.

Residuals:

- B9-update: application update availability is unknown without a release channel
  or signed manifest; download, signing and publishing remain owner-only.
- B14-restart: a connection observation does not identify a supervised CLI process.
  Massion restart cannot prove an external CLI restart; its existing control stays
  unavailable. The narrower reason replaces the obsolete claim that Massion has
  no restart executor.
- B14-update: existing trusted host observations produce connection update state;
  they do not establish application update availability or install an update.

CI owns the full test suite, all 75 screen contracts and actual Electron smoke /
unsigned development packaging. No real models, external accounts, release,
deployment, owner permission changes, remote pairing or merge was performed.
