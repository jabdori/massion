# R-D: evaluated rule decisions and member memory candidates

## Implemented

Stored host-rounding Growth evaluations now produce exact owner decision cards and activity rows. Case inspection reads the same immutable baseline/candidate hashes, input orders and host-observed results. Later and ask again never adopt; act reuses independently measured Growth adoption. The ownerStore drain fence, post-load operation lookup and idempotency-conflict readback remain in the write path. Unknown client answers stay locked across unrelated Mission revisions.

Member model output may propose one named memory instruction, separately from Work steering. The answered turn pins the member, owner message, segment, candidate ID/version/hash, Mission and optional exact source Work. Save first records a durable owner intent and then attempts the original Mission write once. Discard writes no memory. Unknown intent/save outcomes reconcile read-only, including after restart. Explicit and proposed Growth memories retain optional display names and exact source Work metadata. Settings links verify the original input/criteria hashes before opening.

No provider, payment, credential, network effect or automatic memory adoption is part of this evidence. All adapters are fixtures, and case calculation uses the existing bounded local oracle.

## Verification

- `npm run typecheck`; approved-copy lint: zero findings.
- Final changed-path tests: 74 passed, zero failed or skipped.
- Related new/changed tests cover all four recurring bug classes: overlapping commands, drain during writes, stale feed/selection/deadline and late responses. Portable-backup roundtrip retains candidate decisions, names and source pins.
- Existing assistant, member Work, protocol, explicit-memory, Growth and effect suites: 164 passed, 8 actual-DB cases skipped.
- Browser contract captures: B2, B2-offline, B2-offline-failed, B9, B9-restart, B9-update, B12, B16, B16-later, B16-sent, B7-done, B7-unknown, B7-fail, B6, B7-churn, B18 and B18-room-b in both themes. These are affected-screen captures, not an all-screen local gate claim.
- B12: 26/26 required elements in both themes, including name, switch name and exact source Work link. B16: 22/22; B16-later: 21/21; offline variants: 20/20 and 22/22.
- Production loopback Workbench with fixture adapters, driven through agent-browser: case inspection, later, ask again, rule adoption, member memory save and discard. Readback shows the saved/discarded receipts and a stale case pane becomes unavailable after selection changes.
- Captures: `B12-dark.png`, `B12-light.png`, `B18-room-b-dark.png`, `rule-cases.png`, `memory-save-discard.png`. Full measured snapshots/checks remain in `.runtime/ui-contracts/`; generated files are not hand-edited.

## Resolved contracts

Remove 72 resolved diagnostic identities across both themes. Eight identity replacements retain the existing residuals described below; no extra capability is claimed. The net allow-list reduction is 64 entries. Growth and member-memory fixture modules use production reducers/readers, with journal-lineage validation; a missing typed candidate now fails fixture construction.

## Remaining briefing links

B9, B9-restart and B9-update still lack the separate morning-briefing Work link named “반올림 규칙”. The new decision activity title includes its action, so this existing absence is now diagnosed as a conversation link-role mismatch rather than a match in the sidebar. The case inspector is available through its own exact decision. No unrelated briefing Work is fabricated to hide the missing scheduled source. Each theme replaces the old diagnostic identity with its currently measured one.

## Remaining B6 detail

B6 still lacks the recorded research/team and enterprise-steering detail from its older fixture. Its gap text removes the resolved memory-candidate claim; only the existing unsupported details remain. This replaces one gap identity per theme.

## Remaining sent-row chronology

B16-sent now has a real rounding-rule activity row. Reading that row clears its own unread marker; the remaining PR unread marker follows the sent link, while the contract expects an unread marker before it. Retain the existing order diagnostic rather than reorder unrelated activities. The missing-producer gap and missing rule-row diagnostic are removed.

Other unsupported business summaries, unrecorded step times, layout drift and unavailable integrations retain their existing exceptions. Full repository checks and all screen contracts run in CI; actual DB/provider/deployment validation is not claimed here.

## Review fixes

The first CI pass exposed a source-link test that asserted before native hashing completed. It now waits for the actual digest promises; no fixed sleep or implementation change was needed. Codex then identified a pre-intent stale-review HTTP rejection classified as unknown delivery. The route now labels only definite validation/admission failures as rejected, allowing a refreshed owner decision. HTTP and client regressions retain the unknown-intent/save no-resend locks.

Rule-decision admission refusals now carry the same explicit rejected/admission envelope, with HTTP and client coverage proving that a stale adoption may still be deferred. Hidden case panes clear their cached contents when the database feed resets.
