# Owner-selected secret sources (R-T)

## Intent and boundaries

The owner chooses a source for each `(owner, slot)`: Massion's own vault,
an external reference resolved at use, or one import into the own vault.
Members and connections receive explicit, durable, narrow use grants, never
secret bytes. This includes the 2026-11-10 R-T addendum: a member may request
credentials for one declared purpose and Work; only the owner provides them.

Today `SecretSlots` has keychain and fixture-memory implementations.
`host-connections.ts` binds a slot or an explicitly named development environment
variable to exact connection/profile/destination identities. `CliLauncher`
injects slots only after validating its signed executable and sandbox policy,
and redacts delegated values before returning output. Keep those boundaries.
Environment bindings remain an explicitly selected legacy development path.

No changes belong in `src/browser-*`, screen contracts or prototypes. There is
no new dependency, credential inventory, fallback vault, background retry,
autonomy setting, model-visible value or automatic unlock.

## Sources and host composition

A `SecretSource` is `own` (the default), `external-ref`, or `import`. External
sources name a vendor and one bounded opaque reference. Source identity hashes
cover metadata only, never values. The generic external adapter reads one
reference with cancellation; 1Password is the first supported adapter.

Source-aware slots wrap the existing own store. External references are read
on every authorized use and are never copied into the own store. An import
claims durable intent before any write, resolves once, writes the existing own
slot, then records completion/provenance without the value. An unresolved
write remains unavailable after restart: neither `has` nor a lost receipt
authorizes another import. Completed imports read only the own store. A changed
reference/source requires a new explicit grant; it never inherits permission.

The host manifest extends slot credentials with an optional `source` and
explicit non-secret 1Password configuration. The normal CLI still loads this
through `--host-config`. Construction and metadata reads never resolve values.
Connection/profile/destination pinning stays in `compileHostBindings`.

Use grants extend the existing `PermissionsService` owner-command path, not
the learned allow-rule kinds: secret scope is always an explicit owner decision.
A grant binds the exact slot, source hash, consumer kind/identity and purpose.
Revocation and source changes fail closed. Authorization is checked before and
after asynchronous resolution against the original database feed and current
grant. The server continues to pass its drain-aware `ownerStore` for writes.
Existing work execution grants are still required independently.

## 1Password adapter

Official documentation checked on 2026-11-10 through Context7:

- [Read a secret reference](https://www.1password.dev/cli/reference/commands/read):
  `op read`, `--no-newline`, no output file.
- [Global flags](https://www.1password.dev/cli/reference): explicit account and
  configuration directory, `--cache=false` and `--no-color`.
- [Environment variables](https://www.1password.dev/cli/environment-variables):
  `OP_SESSION` and `OP_BIOMETRIC_UNLOCK_ENABLED`.
- [Manual sign-in](https://www.1password.dev/cli/sign-in-manually): an owner signs
  in separately; an inactive session expires after 30 minutes.

Use a fixed absolute executable selected by the trusted host, never PATH or a
shell. Resolve/check its filesystem identity before invocation. Pass references
as a single argv element, stdin closed, detached process group, bounded output
and a five-second deadline. Pass only the explicitly selected session token and
fixed CLI settings; never inherit `process.env`, loader/debug variables,
service-account credentials or Connect endpoints. Disable desktop/biometric
integration and caching. Never invoke signin, unlock, account discovery, run,
inject or an interactive command. Missing session authentication is
`needs-owner-unlock` before spawn; no app is opened.

Typed failures include `needs-owner-unlock`, `cli-missing`,
`reference-not-found`, `permission-denied`, `timeout`, `cancelled`,
`grant-required`, `import-unavailable` and `unavailable`. Vendor stderr is used
only for bounded classification and is discarded; unknown formats map to
`unavailable`, never a claimed reason. No raw diagnostic/cause is propagated.
The host exposes safe typed state, not references, session tokens or values.

## In-conversation requests (addendum 1)

A host-validated member request declares a member, Work, label, purpose and a
bounded list of slots with field kinds (`id`, `password`, `one-time-code`). It
contains no values. The durable request hash pins those exact fields. Requests
are owner decisions, survive restart, are single-use, and block new effects
while open. Decline remains terminal; an interrupted provision is unavailable,
not permission to replay. The model learns only `provided`, `declined` or
`unavailable`; an open request suspends work rather than returning a secret.

An owner provision claims the exact request before accepting effects. Typed
values go directly to the own vault; external references remain references;
imports write once to the own vault. Journals and backups contain only request,
source and provenance metadata. Successful provision grants only that member,
that Work, those slots and that declared purpose. It does not grant a model
read API or broader connection/member access. Host consumers resolve the
granted slot at their existing injection boundary. Stop, drain, changed feed
and changed/revoked authority still prevent use.

The existing app connection form takes one app token; the connection repair
form takes one API key. Neither contract describes member/purpose/field-kind or
source selection. This PR therefore adds backend request transitions and safe
states, but no new UI. Proposed owner UI: a decision-style conversation card
with `입력`, opening a host-rendered scoped form with own/reference/import choice.
The form must clear values on close/send, never append them to conversation or
retain them in client state/storage. UI approval is a follow-up, not claimed here.

## Implementation and verification plan

1. Commit this design alone and put its summary in the PR description.
2. Add failing fake-vendor tests for argv-only execution, environment isolation,
   deadlines, cancellation and every typed failure. Implement the adapter and
   source validation using the existing bounded process runner.
3. Extend the existing durable owner permissions and backup replay for exact
   secret grants and single-use import receipts. Test overlapping commands,
   source changes, revocation, feed replacement, drain and restart before adding
   source-aware slots and normal host manifest composition.
4. Add failing request tests, then implement the Work-bound owner decision and
   provision path, single-use grants and pause/resume gating. Exercise direct
   own input, references, imports, decline and interrupted writes. Project only
   safe states through host APIs; keep unapproved UI in the PR follow-up.
5. Run typecheck and affected tests locally. Assert sentinel absence from
   journals, portable backup, model input and public results; use fake vendor
   executables and fixture own stores only. Never use a real vault, login
   keychain, GUI prompt or real model. Any keychain integration test must name a
   disposable explicit keychain and suppress interaction.
6. Push and run the requested CI/Codex loop on each final head, at most four
   rounds. Merge main if necessary; never rebase, force-push or merge the PR.

## Limits for 1.0

Other vendors need separately verified official authentication/error contracts.
Windows/Linux own stores need a platform-specific protected storage boundary.
Website autofill waits for the browser form slice and its injection contract.
No live 1Password, signed native host or keychain interoperability is claimed by
fixture tests. The existing keychain CLI/ACL integration can require OS approval;
unattended packaging still needs the dedicated native host described in
[secret-launcher.md](secret-launcher.md). Same-user debuggers and a malicious
trusted vendor binary are outside process-environment isolation.
