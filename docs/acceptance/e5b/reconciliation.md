# Independent-review reconciliation fix

Addresses the medium finding on `src/apps.ts`: an unknown write previously blocked all later writes of its app permanently. The conservative block remains. An explicit owner command now resolves exactly one unknown call to done/not-done with evidence, actor and host time recorded. There is no adapter invocation, replay, automatic clearing, or grant widening in the reconciliation path. Pending calls remain blocked and cannot be prematurely reconciled.

## Verification

- Reducer/service tests cover unknown blocking, both outcomes releasing the block, exact app/call binding, nonempty evidence, owner-only authority, refusal of pending calls, overlapping command replay, original-call replay without invocation, and journal lineage. HTTP checks exercise the existing owner route and stale-feed refusal.
- Client tests cover the blocked tool-only app entry, existing unknown/no-resend wording, required evidence, one submission under overlapping clicks, lost-response no-resend and feed invalidation.
- The real loopback host/store/reducer were driven by headless agent-browser in both media preferences. The only transport was an injected fixture. `reconcile-smoke.mjs` asserted one send before reconciliation, still one after reconciliation and original-call replay, and two only after a distinct new write.
- [Browser report](reconciliation/report.json), [dark unknown](reconciliation/dark-unknown.png), [light unknown](reconciliation/light-unknown.png), [dark reconciled](reconciliation/dark-reconciled.png), [light reconciled](reconciliation/light-reconciled.png). Accessible snapshots are alongside the images. No personal credential or live MCP service was used.

## CI corrections in the same round

- [Desktop correction](desktop-ci-fix.md): the build previously injected its bridge into `</body>` inside the iframe's JavaScript string. The builder now anchors to the outer document suffix; a regression parses both emitted scripts and verifies original-byte preservation. Linux Xvfb smoke passed with sandbox, isolation, CSP, theme, notification focus and close/reopen checks retained.
- Full-suite CI also exposed initialization order on restoring an offline draft: `chatRestoreDraft` could synchronously call `appConnectClose` before its lexical state existed. The connection client now initializes before the chat client. The existing failing test in `tests/ui-offline.test.ts` was reproduced and passed after the reorder; no resend guard was weakened.

The old PR-row/Work-result visual residuals are unchanged. No additional independent reviewer was spawned: the separate worker investigated the CI implementation failure; independent acceptance remains with the lead.


Final affected-suite results: **173 passed, one real-DB skip, zero failures** across the app/backend/client/desktop-build checks ([log](desktop-ci/review-tests.txt)). The final offline/connection/reconciliation/build rerun passed **37/37** ([log](desktop-ci/offline-init-tests.txt)); UI layout/readback checks passed **24/24**. Root typecheck and desktop typecheck passed. The final rebuilt Linux Xvfb smoke exited 0 ([log](desktop-ci/smoke.log.txt)). The previous main-head `verify` and `headless` CI failures were reproduced and corrected; remote CI must run again on the pushed result.
