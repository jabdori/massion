# PR 109: durable CI and unknown-save follow-up

## Actual CI environment

Use an owned Linux amd64 container with Node 24.19.0 and the same official
SurrealDB 3.3.0 Linux amd64 archive as `.github/workflows/check.yml`.
SHA-256: `44aeab565f7e7e39d2d0bf0583c8aae648babc91373c70b2658288d95bbbcd55`.
The container uses `--init` so the Python launcher has a non-1 PID and the
existing disposable-process ownership guard can verify its ancestry. No guard
is bypassed. Database state lives in the container's Linux filesystem; no user
DB or provider account is involved.

## CI request-count cause

CI run 42582334030 observed 17 requests after taking a 16-request checkpoint.
Trace the extra call to `GET /assistant/works` from the existing
`chatReadLoop` finally block (`src/assistant-conversation-panel.ts`), via
`shellWorksLoad` (`src/surface-shell.ts`). Both implementations are identical
to main. No Settings read occurs in that trace.

Feed replacement starts a conversation read. Its completion starts a background
Work-list read, independent of the disabled relation buttons. The test held the
Mission snapshot response but did not synchronize that separate background
read before recording the total request count. A controlled gate on the
replacement host's conversation response reproduces the exact 17 != 16 failure
on both PR 6099dda and main d435690 with actual SurrealDB.

Keep that gate as a regression and wait for the already-scheduled Work read to
start before recording the checkpoint. The exact total-count assertion is
retained, as are every original private-field, original-revision/CAS,
old/replacement journal and no-POST assertion. No expectation is changed to 17,
no requests are filtered out of the assertion, and no production request is
added or removed to disguise the race.

## Unknown group reconciliation

A lost save remains readonly. An earlier in-flight catalog read cannot unlock
it. A later successful, current-scoped `/connections` read with modelGroups and
a nonempty configHash adopts host values and clears the unknown lock. Failed,
malformed, replaced-feed and out-of-order reads do not authorize a write.
Reconciliation never resends the lost command; a later manual edit uses the
fresh host CAS hash. Regression tests demonstrate RED then GREEN for the lost
save / earlier read / fresh read sequence and reject malformed reads.

## A9: expired and update status evidence

`src/connection-workbench.ts:134` produces only `fixture`,
`cli-login-unverified`, `configured-unverified` and `credential-required` for
connectionStatus. It returns credential configuration and model-discovery
metadata, not token expiry or installed CLI update state.
`discover` at line 136 explicitly refuses subscription CLI model listing; its
HTTP metadata-list failure does not classify an expired token. The server's
connection route table (`src/server.ts:131-150`) adds no login, expiry,
installed-version, update or native-restart query/action.

The protocol-level `update-needed` state concerns client/host wire
compatibility, not a particular subscription CLI or API key. A declared host
credential reference is not proof that a token is valid or expired.
B14-expired and B14-update therefore retain the truthful unverified display
and remain explicit capability residuals. Their fixtures do not invent red
expired/update labels or success/reconnect actions.

## Approved copy correction and accessible order

Owner feedback A2 explicitly changes B23 headings to `설치됨 1` and
`직접 만든 앱 1`. Update exactly those two heading strings in B23's
contract to the approved spelling; requiredness, order, occurrence, regions
and all budgets are unchanged. The checker is unchanged.

A5 keeps avatar/name/chevron visual order. The busy avatar is decorative;
a separate visually-hidden status follows the member name in the accessible
text. This preserves the truthful running state without consuming its
occurrence before the member link. The existing DOM/role test was first
observed failing, then passing, and the headless B20 contract returns 30/30.

## Local architecture and process-identity proof

The macOS host is arm64. The amd64 container reproduced the relation race and
passed the gated fix on real SurrealDB, but its full-suite attempt stopped at
an unchanged normal-CLI process-identity test. A direct child-process probe
observed injected `--no-opt -r /proc/.p` arguments in `/proc/<pid>/cmdline`
when spawning the amd64 Node binary. The repository intentionally verifies
exact argv before process signals; that guard is not relaxed.

Run the full unchanged CI command in native Linux arm64 instead, as user
`node`, with Node 24.19.0 and official SurrealDB 3.3.0 linux-arm64.
The official release asset's published SHA-256 is
`f03356497f875057126641f06757671542e0a7b75f18fd13820c2dab29349d74`.
Version, SurrealKV durability, restart flag, ownership checks, namespace,
loopback isolation, and deny-net/deny-scripting flags match the CI launcher.
No skips or timeouts are added to the suite. The ordinary conditional browser
skips also occur in the original CI run (33).

## P2 follow-up after PR 110

Merge main `9dc70dc`, preserving its app-page styles/functions and additive copy/visual data, then regenerate tokens. After a group save settles, clear settingsBusy and rerender the currently selected Settings section, including a different group opened while saving. Enforce 1–16 profiles in the shared save path and disable spare picker choices at 16. Two regressions were observed failing before the fixes and passing afterward: A → pending save → B remains selected and becomes editable; 15 → 16 disables model 17 and even a synthetic click sends no second POST. Related Settings, reconciliation, apps and shell tests: 82 passed; typecheck passed. Per the owner process update, no full suite, contract runner or pair recapture was repeated for this round.
