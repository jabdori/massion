# App secret presence

Settings reads use the optional metadata-only `AppSecrets.has` for the installed
app's connection slot. An absent slot projects `missing` even when the journal
retains a saved or expired receipt, including after restore on another machine.
A failed metadata lookup projects `unknown`; presence never verifies provider
authentication. Set-only adapters retain the existing receipt projection.
Pending connection claims always project `unknown` and continue to block resend.
No secret value is read, no receipt is rewritten, and historical completion
commands keep their original replay output.
Confirmed presence projects saved storage for legacy completions that lack the
new credential receipt. Existing expired receipts and pending claims take priority.

After pending-tool recovery, `readState(APPS_ID)` atomically captures the app
snapshot and its database feed. After asynchronous member and presence reads,
another atomic read must match both feed and app revision. A mismatch rejects
the result rather than mixing metadata with a replaced database or app source.
The server may additionally fence the whole GET against its original feed.

Presence uses the existing bounded read-only call wrapper: timeout is five seconds,
shutdown aborts the wait even if an adapter ignores its signal, and late answers
cannot replace the already projected unknown state. The wrapper never reads a
secret value and never retries a connection write.
