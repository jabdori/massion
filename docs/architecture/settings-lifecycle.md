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
