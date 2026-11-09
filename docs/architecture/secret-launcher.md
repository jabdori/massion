# Secret slots, bounded CLI launches and tool deadlines (E5a)

ADR 0005 sections 5 and 7 require host-only secrets and bounded effects. The
existing CLI provider already converts uncertain execution into ProviderOutcome
`unknown`, which the runtime journals through the original claimed effect. Keep
that machinery and the existing ownerStore; add no client secret endpoint.

## Scope and implementation plan

1. Add `src/secret-slots.ts`: `(owner, slot)` identities, macOS keychain adapter
   and an in-memory test adapter. Use `/usr/bin/security -i` with one bounded
   command on stdin for writes (hex data, never argv), and piped reads. Suppress
   raw diagnostics. Host manifests may bind a slot instead of a development
   environment source; bind resolution to the same exact profile and endpoint.
2. Move the existing process runner to `src/cli-process.ts`; retain its exports
   for callers. Add `src/cli-launcher.ts` with host-owned exact argument patterns,
   environment names and secret slots, macOS signature requirement, read-only
   sandbox and final file identity comparison. Refuse missing platform/trust
   bindings. Keep fixture runners explicit. Deduplicate by invocation identity
   before asynchronous reads; retain results to prevent a second dispatch.
3. Add `src/tool-call.ts`: host defaults (180 s tools, 5 s handlers), cancellation
   and a bounded result even if an adapter ignores cancellation. Reads fail;
   dispatched writes are unknown. No automatic retries. CLI adapters translate
   to existing outcomes; app calls receive cancellation and generic errors.
   App page/item reads cannot dispatch writes without durable Work claims.
4. Write sentinel, argument rejection, environment, concurrency, deadline and
   durable no-resend tests first; observe failure, implement, run affected tests
   and typecheck. Commit, push, open the requested PR and request Codex review.

## Security boundaries and limits

Only host code can construct policies or resolve slots. No values enter client
messages, manifests, hashes or persistent receipts. Outputs containing delegated
secrets are redacted before parsing/persistence; errors never retain causes.
The subprocess runner never logs. A child receives only declared variables and
injected slots, and no shell. Secret access is lazy and abortable.

The launcher requires an absolute signed executable and explicit signing team
and identifier; it does not trust the current PATH or invent vendor identities.
Its sandbox permits system/runtime reads and the owned work directory, and
refuses other user data, keychains, SSH/cloud credentials and host data. Existing
subscription CLI factories fail closed without a host-installed trusted launcher;
fixture runner injection is retained. Packaging must supply verified targets and
subscription authentication access before advertising live CLI availability.
Electron utility-process packaging, enrollment UI, MCP transport, remote scope
issuance and per-day quotas are outside this slice. No real credential, provider
call or personal keychain mutation is part of tests. Child environment isolation
does not hide secrets from a debugger or another process with the same OS user;
this adapter is not an OS-user isolation boundary.

Development environment-backed manifests remain explicit for compatibility;
macOS slot manifests use only keychain storage and never fall back to environment.
A sandboxed CLI can still deliberately transform its input: literal redaction is
not a defense against a malicious trusted executable exfiltrating encoded data.

## Sources checked

- Node 24 child_process documentation via Context7 (2026-11-09): explicit env,
  argv without shell, process-group termination.
- Apple SecurityTool `security.c` and local `security help add-generic-password`:
  interactive stdin is not echoed without verbose mode; its line limit is 4096.
  https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c
- https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain

## Implementation notes

New runtime admissions pin `toolTimeoutVersion: 'tool-timeouts/v1'`; profile
hashes keep any tighter provider deadline. Backup lineage accepts the new version
and still accepts old runs without the optional field. Read timeouts may be
explicitly tried again by their caller; this layer has no automatic retry.

Production launcher working directories must be private, OS-user-owned
`massion-cli-*` directories directly under the canonical temporary directory.
Signature checks precede slot reads; device/inode/size/mtime/ctime are compared
synchronously immediately before spawning. This narrows replacement races; a
same-user hostile process can still race the pathname after that check. Stronger
OS-user/descriptor-based execution needs a packaged native launcher.

Process cancellation sends SIGTERM for cleanup, then group SIGKILL after 100 ms;
pipe cleanup is bounded at one second. The caller may already have an unknown
outcome during that grace and cannot infer a remote stop.

Launcher and CLI provider instances retain up to 1024 invocation identities and
refuse new ones at capacity. They never evict an unknown result to permit replay.
Durable Work claims, rather than these local maps, prevent replay after restart.

## Verification (2026-11-09)

Node 24.21.0 on macOS; no real credentials or model calls. Typecheck and
`git diff --check` pass. The 11 related suites (slots/launcher/runtime, tool calls,
CLI providers, host connections, apps, run lifetime, dispatch, configured runtime,
backup lineage and portable backup) report 125 tests: 111 pass, 13 skip and one
known local failure. `portable inventory order is stable across English and
Turkish process locales` fails with `directory realpath mismatch` on the existing
case-sensitive `I`/`i` fixture; CODEX-BRIEF already records this macOS limitation.
Durable database tests are skipped without the explicit integration fixture.

Observed regressions before their fixes: unsafe app diagnostic echo, unclaimed
app-view writes, unbounded invocation when cancellation is ignored, overlapping
CLI provider dispatch, absent cleanup grace, and rejection of the new timeout
version by backup lineage. Sentinel tests cover actual child environment and
split stdout, generic errors, journal/Record/artifact/client responses, overlapping
launches and restart no-resend. Real macOS codesign rejects the wrong team before
slot resolution. Keychain mutations and successful vendor-signed sandbox launches
remain mocked; CI owns the full suite and screen contracts per the owner's budget.
