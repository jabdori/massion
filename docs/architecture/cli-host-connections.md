# Normal CLI host connection setup

The normal `npm start` entrypoint can load host-owned provider bindings without
editing source. This is a trusted single-owner loopback development setup, not
production authentication, account enrollment, persistent grants or live proof.
It is a successor to provider-only PR #8 and addresses issue #9.

## Explicit startup

```sh
npm start -- --host-config /owner-selected/host-connections.json
# Configuration/discovery only; live Work permission is disabled.

npm start -- --host-config /owner-selected/host-connections.json --allow-live-model-calls
# Capability only: choose roles, grant a scope, check the current Work, then Run.
```

The existing explicit SurrealDB endpoint/namespace/database and loopback port
settings still apply. The selected manifest is validated before database access.
Unknown/duplicate options fail startup. Live capability requires an HTTPS manifest;
no option, environment switch or manifest field silently enables it. With no
manifest, the preexisting credential-required setup/manual metadata path remains.

## Versioned non-secret manifest

```json
{
  "version": 1,
  "revision": "owner-binding-v1",
  "mode": "https",
  "connections": [
    {
      "id": "owner-chat",
      "label": "Owner Chat account",
      "providerType": "compatible",
      "baseUrl": "https://owner-chosen.example/v1/",
      "models": ["owner-chosen-exact-executor", "owner-chosen-exact-reviewer"],
      "credential": {
        "ref": "owner-chat-reference",
        "environment": "OWNER_CHOSEN_MODEL_SECRET"
      }
    }
  ]
}
```

The example contains placeholders, no working account or default model. Choose
the exact endpoint/models and an environment variable you explicitly supply to the
host process through your own approved secret mechanism. Do not put the value in
this JSON, command arguments, browser form or repository. No provider environment
name is inferred, and no home directory, credential store or alternate source is
searched. Secret files and OAuth are not supported in this slice.

Manifest version 1 uses an exact schema, 32 KiB/complexity bounds, 1–32 connections
and at most 64 exact models. HTTPS requires one declared environment reference per
connection; references and connection identities must be unique. Official presets
retain their canonical bases; custom HTTPS destinations use `compatible`. The
loader reads only the selected bounded regular file and rejects symlinks, invalid
UTF-8/JSON, unsupported fields (including raw-secret fields), invalid destinations
and duplicate entries. Runtime configuration is a snapshot, not a file watcher.

## Binding and user flow

The canonical complete manifest hash, including its non-secret revision and source
declaration, determines connection identities. Model profile identities also pin
that binding. Change the owner revision when changing account authority; changing
any manifest content changes its hash even if the revision was accidentally reused.
This pins declared authority, not independently verified provider account ownership.
Actual secret values are never hashed or included in a profile.

Startup creates only the declared connections/models and performs no discovery,
credential lookup, grant or inference. The UI shows the host revision and live
capability, hides connection mutation, and permits model exploration/selection.
Discovery results are filtered to declared models; exact manual selection cannot
expand that list. Destinations, references or models require editing the selected
manifest and restarting. The HTTP connection-mutation route is also guarded; the
UI is not the sole enforcement point.

The pure enrollment/selection rules ensure catalog and preflight use only declared
bindings without reading values. Discovery requests bind the connection identity
and exact models endpoint; inference binds the derived profile identity and exact
model endpoint. Both require the same declared opaque reference. Only after these
checks and a non-aborted signal does the resolver look up that one named environment
value. It checks cancellation again after lookup, rejects missing/malformed values
and sanitizes source errors. No implicit fallback, retries or redirects are added.
An existing reference/resolver is displayed as configured-unverified; it does not
claim that a value or account has been validated. Missing values fail without a
provider send. Public catalogs expose neither references nor environment names.

The separate live option allows live scoped grants; it does not create one. A live
grant the owner created earlier under the same manifest is restored from host settings,
but it is active only when this start also has the live option; otherwise it is listed
as `live-disabled`. A restored live grant or live default route is counted in the
startup log and listed with its scope and mode in `GET /connections`
([default route and persistent connections](default-route-and-persistent-connections.md)). Exact
Mission scope, executor/verifier profile hashes, output cap, budget, current revision
and explicit Run remain the existing product-owned path. Output bounds are not
money or total-token limits. Usage can remain unknown; cancellation cannot undo a
previously sent request. Existing interrupted effects are observed, never replayed.

## Credential-free fixture mode

For an explicitly owned disposable loopback provider, a manifest may set
`mode: "local-http-mock"`, use canonical `http://127.0.0.1:PORT/.../` bases and omit
all credential fields. It uses the real CLI and Work path but sends no credentials
and produces fixture-class evidence. `--allow-live-model-calls` is rejected for
this mode; HTTPS and fixture connections cannot share one host session. This is
an explicit developer fixture capability, not live account validation.

## Restart and evidence boundaries

Declared connections/models are enrolled again at startup. Owner model labels,
scoped permissions, revocations, default routes and discovered metadata made under the
same manifest are restored from the `massion_host_settings` table, without secret
values ([default route and persistent connections](default-route-and-persistent-connections.md)).
A changed manifest is a new, empty settings scope. Durable Mission/Work/Records and
pinned effects remain in SurrealDB and the existing artifact root. Restart does not
dispatch, create a permission or resume old effects—even when host bindings change.

Tests use synthetic value accessors/intercepted HTTPS-shaped transports for exact
credential headers and lazy binding, plus actual normal CLI subprocesses with a
new disposable SurrealDB and credential-free native loopback providers. They cover
startup rejection/redaction, managed UI, explicit accepted fixture Work, stale
revision, cancellation/unknown usage, shutdown/restart and no replay. They do not
prove real provider compatibility, live competence, deployment, secure OS secret
storage, multi-PC sessions or production caller identity.

## macOS keychain slots (E5a)

An HTTPS connection may instead declare `"credential": {"ref": "owner-ref",
"slot": "api-token"}`. The keychain identity is `(connection.id, slot)`; the
reference still binds exact model/discovery endpoints and profile identities.
The manifest cannot combine `slot` and `environment`, and missing/locked slots
never fall back to environment. The host-only `KeychainSecretSlots` adapter
creates, reads and deletes values; there is no client read/write-secret route.
Values are bounded to 1024 UTF-8 bytes. A slot change changes the manifest hash;
a value rotation does not. Environment-backed manifests remain development-only.

CLI connections now require a host-installed `CliLauncher` through
`createHostConnections(..., {cliLaunchers})` (or `ConnectionWorkbench` options).
Policies pin an absolute binary, signing team/identifier, argument patterns,
environment names and delegated slots; the normal CLI does not auto-discover or
trust a PATH binary. Without that binding it refuses execution. Fixture runners
remain explicitly injected. The desktop packager must provide audited vendor
identities and permitted subscription authentication before enabling these
connections. See [secret launcher boundaries](secret-launcher.md).
