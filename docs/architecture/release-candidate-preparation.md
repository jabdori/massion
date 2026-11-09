# Release candidate preparation (E9c)

The root package version identifies the source candidate and the packaged desktop
app. Desktop packaging injects it as Electron metadata; the desktop dependency
manifest has no independent version. The first candidate is `1.0.0-rc.1`.

The existing macOS CI job builds an app without a Developer ID signature or
notarization, runs an install smoke against the authenticated fixture supervisor,
and archives the tested bundle with `ditto` to preserve executable modes and
symlinks. This is a development artifact, not a Gatekeeper-approved distribution.

The normal packaged launcher supports an explicit `--massion-headless` launch.
It requires a private user-data directory, disables GPU acceleration, suppresses
window showing/focusing and notifications, and keeps the existing sandbox and
transport authentication. The install smoke drives the actual bundled workbench
through CDP on loopback: connect, inspect an unknown Work, open its details and
confirm its uncertainty remains. It saves screenshots, a snapshot and a report,
then stops only its own app and drains its disposable supervisor. No model,
account, persistent installation or owner window is used.

Validation extends desktop build/package tests for shared version metadata and
hidden-window behavior, then runs the existing desktop suite, typechecks and the
actual macOS package smoke. Full durable and browser suites remain CI gates.
Signing, notarization, tags and publication are owner-only steps documented in
`docs/guide/release.md`; none run in candidate CI.
