# E6c acceptance evidence

Payment and external-member decisions use the production Work effect reducer, decision service and `/assistant/decisions` route. Only explicitly registered fixture adapters run. A proposal pauses the Work; one owner approval permits one fresh committed dispatch claim. The request, input hash, original idempotency key, answers and remote receipt remain in the journal. Timeout, receipt mismatch, lost storage reply, shutdown and restart do not resend.

## Verification

- Targeted Node 24 tests cover effect/owner authority, exact pinned requests, overlapping commands, expiry/input changes, feed replacement, host drain, timeout/late receipt, inert journal replay, the normal HTTP route and UI generation guards.
- `npm run typecheck` passes; UI copy lint reports no findings.
- [Browser interaction](interaction.json): later → ask → act through the rendered UI and production service; exactly one fixture transmission, remote arrival recorded as `received`, Work outcome still `unknown`, reload without another send. This is a synthetic loopback test transport; the normal server route is separately tested.
- [Contract report](report.md), [raw report](report.json), `checks/`, `snapshots/`, `visual/`, `screenshots/`, and `pairs/` retain B4, B16, B16-sent and B16-later in dark and light. Pairs place the approved artboard on the left and the application on the right. All eight pairs were inspected.

## Residuals

B4 supplies all required occurrences, including the three separate amount slots and decision-pending sidebar state. The pane is a host-rendered read-only checkout inspection, not a live third-party browser: it deliberately has no second payment control or external navigation. Background Work examples, recorded page count/time and ancillary shop decoration differ from the prototype.

The B16 variants retain the missing Representative rounding/check-rule proposal. Its row and unread occurrence cannot be fabricated from the external-member decision; the sent-state order diagnostic follows from this absent preceding row. These failures remain in the report and in [E3e residuals](../E3e/residuals.md). No checker, contract, text budget or CI switch was relaxed.

## Not run / not claimed

No real payment, remote device, provider model, credential delegation, deployment or merge. No live checkout screenshot or provider-confirmed order-history reconciliation. The default host has no effect adapter, and refuses approval when one is unavailable. Persistent trust of a device across different Work admissions is not added: each pinned handoff needs its own owner decision. Full-suite and full-contract runs belong to CI under the owner's verification budget; independent review belongs to the lead and the requested Codex PR review.
