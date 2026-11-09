# Connection, app and member lifecycle (R-C)

## Intent and boundaries

Complete the existing Settings lifecycle surfaces from B13/B14/B19/B23 through
product-owned commands and real read shapes. Reuse the existing owner decision
route for admission and permission changes, the drain-aware owner store, secret
slots, command identity replay and generation-scoped client reads. Never infer
credential validity, remote delivery, member bindings or installable packages.
Unknown effects remain unknown and are never automatically resent.

## Implementation plan

- [x] Extend connection rechecks and key replacement using the existing login,
  connection settings and secret-slot boundaries; expose only non-secret state.
- [x] Extend member reads and owner archive/unarchive, retaining identity,
  historical Work and conversations. Derive counts and activity from stored data.
- [x] Extend app member bindings and token reconnect using existing app decisions
  and secret slots; expose catalog entries only for actual installable packages.
- [x] Add remote device list/connect/disconnect over the external admission
  boundary, without equating a connected device with an accepted Work.
- [x] Connect Settings controls, scoped reads and production-derived fixtures;
  remove only contract exceptions the new producers actually resolve.
- [x] Run focused red/green tests, typecheck and headless interaction checks.
- [ ] Push this branch, open the requested PR, and run its CI/Codex review loop.

## Verification focus

Overlapping identical commands replay their original result after loading state.
Owner writes are rejected during drain. Database feed/selection changes and
out-of-order reads cannot revive stale controls. Secrets never enter state,
events, logs or read responses. Archiving cannot delete evidence or silently
reassign active Work. No test invokes real providers, payments or remote devices.
Full-suite and full-screen contract execution belongs to CI under CODEX-BRIEF's
verification budget; fixture success is not live integration evidence.

The bounded delivery and remaining producers are recorded in
[the acceptance ledger](../acceptance/rc/README.md#remaining).

## Owner visual-gate correction

Follow the existing B13/B14/B19/B23 artboards and tokens: a devices title/action
row, icon/status rows, lifecycle problems in connection sublines, member metadata
beside the avatar, canonical skill provenance, archived identity/details and app
versions. Remove the uncontracted app member-checkbox editor. Display member
memory only with an explicit host binding and use its actual removal command;
never reinterpret unrelated Mission memory as member memory. Keep capability
residuals for unavailable producers/executors. Fixture member names are Korean.

Connectivity retains an approved device binding when a later Work merely
proposes another handoff. The complete approved request remains the target; a new
pending request cannot substitute another adapter or grant itself Work authority.

## Shutdown and uncertain member receipts

Device drain checks durable connectivity operations after waiting for active
adapters. Unknown outcomes or rejected in-flight operations reject drain, so the
existing host drain aggregation reports unsettled rather than a clean CLI exit.
No adapter is invoked by the drain check.

Member archive/restore has no external effect. Settings retains the exact command
ID, action and member ID after a lost answer, asks the existing members GET for
its fingerprint-matched receipt, and clears only that feed-scoped uncertainty
lock after confirmation. Reading the current archived state alone is insufficient;
unknown receipts remain fenced. The next read supplies the current member view
before an inverse owner action is exposed. No uncertain command is resent.

A new device claim also retains the approved binding's display names alongside
its existing decision, device and adapter identities. Later reads start from
these durable bindings and overlay current intake decisions; an unanswered new
handoff cannot erase the approved binding. This is connectivity authority only,
never Work dispatch authority. Legacy claims without display metadata retain
their replay shape. Definite member reducer refusals are explicit rejected HTTP
outcomes; uncertain store commits remain unclassified and fenced.

Superseded read-only rechecks are terminal stale observations, not uncertain
writes. Device response recovery retains command/device/action identity and reads
the exact durable operation's settlement before unlocking its inverse; an unknown
claim stays fenced. Key replacement must invalidate persisted discovery as well
as memory, so restart cannot restore the previous account's model metadata.
CLI login/status drain must await the underlying runner's cleanup promise, even
when the bounded response has already rejected on cancellation.
