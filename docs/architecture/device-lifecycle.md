# Device lifecycle and General settings (R-L)

The desktop shell owns installed version and this device's notification preference.
It exposes narrow, main-frame-validated IPC methods for reading settings, saving
notifications, and restarting Massion. Browser clients retain unknown native facts.
No application aggregate or external credential is changed by these operations.

Notification preference is a private JSON file under Electron userData, replaced
atomically before a save is acknowledged. The running observer keeps its startup
preference: a saved change produces restart-required until it is reverted or a new
process loads it. Notification settings control delivery, not OS permission.
Reads and saves are serialized. The client ignores superseded reads and blocks
concurrent saves; reopening settings reconciles a lost response without resending.

Restart is single-flight and drains the authenticated local daemon first. Only a
confirmed drained daemon (or an absent socket) permits app.relaunch and app.quit.
An unsettled/unknown drain blocks repeated restart and leaves the shell open for
inspection. It never retries Work or external effects. Installed version comes
from the packaged app metadata (root package metadata in development).

The profile and Devices show these local facts; General has the notification
selector, version and pending-restart status/action. Existing device admission,
inspection, connect/disconnect and member projections remain authoritative.

A CLI connection's restart observation does not identify a supervised process.
Restarting Massion cannot prove that an external CLI installation was restarted;
its restart control remains unavailable with that precise limitation. No release
channel, signed manifest or installed updater exists, so application update
availability remains unknown. Existing trusted connection update observations
remain connection facts. No downloads, signing, publishing, deployment or remote
pairing is added.

Validation: failing-first desktop persistence/drain/IPC tests, settings client
race and reconciliation tests, fixture-derived screen captures in both themes,
root and desktop typechecks; CI owns the full suite and all screen contracts.
