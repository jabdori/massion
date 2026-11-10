# Browser environment actions (R-U2)

## Design before implementation

Bind the existing EnvironmentActions ledger to an owned, persistent, script-disabled headless browser. Reuse the read runtime's exact HTTPS-origin deny proxy and private-page sanitizer. A trusted host supplies bounded element declarations and boolean state predicates; page labels and text cannot grant permissions or prove confirmation. Unknown clicks, selections and submissions require irreversible-submit approval. Personal data, terms, account creation and payment retain their explicit gates. Payment actions and human-check controls are never dispatched.

Serialize all adapter observation and delivery operations for each environment across service instances, including observation reconciliation and the action claim. Owner cancellation remains available while an adapter is pending. A timed-out adapter must settle before another operation can enter; timeout is not proof of cancellation. Preserve the existing command lookup after loading, ownerStore admission, feed pin, single-use secret resolver and unknown/no-replay behavior. Carry PR #155's held-B-observation versus approved-A-execution regression.

A browser session has an opaque surface identity, monotonically increasing document generation and observation revision. Host declarations, actual target identity, form routing and operation policy are checked immediately before input in one browser task, and again after secret resolution. No secret travels in command-line arguments, logs, durable observations or error causes. Secret bytes are erased at the adapter boundary; the session stays private thereafter. Public page observations keep origins only, suppress private text, and never persist images. A read does not sanitize or otherwise modify the live form.

An owner-needed wait uses only its declared boolean state transition and the existing bounded polling ledger. Page text, an owner saying “done”, a delivered click or an approved payment intent cannot prove an order or payment. Delivery remains distinct from independently observed state and accepted Work output.

## Integration and verification

Implement the adapter and serialization first, with fixture tests that fail before implementation. Then bind member procedure steps to the existing Work commands and presentation slots, generate affected fixtures through those commands, and remove only allow-list entries supported by the resulting facts. No contract or prototype changes and no scenario-specific product branches. If the first slice reaches roughly 1,500 added lines, deliver adapter + serialization + tests as PR (a); Work wiring, fixtures and allow-list remain PR (b) in a new lead-provided worktree.

Local checks are typecheck and affected tests only. Browser checks use synthetic local HTTPS form pages in headless sessions, fake secret bytes and an out-of-band confirmation simulator. Never run real accounts, payments, models, keychain or vault commands. Screenshots are needed only if product pixels change. Push once per round, collect both lead and head-SHA Codex review, batch fixes, and stop after at most two fix rounds. Do not merge.

## First PR boundary

Deliver the complete adapter/serialization boundary first under CODEX-BRIEF's smallest-complete-slice rule. The current member runtime explicitly forbids tools and only consumes text worker results; adding durable procedure suspension, authenticated owner answers and continuation is a separate security boundary, not an adapter switch. R-U2(b) still owns that Work binding and the generated fixtures/allow-list. This first PR does not enable actions on a server route and makes no complete-R-U2 claim. A separate branch/worktree must be provided by the lead for the second PR.

The owned browser keeps scripts disabled and disables back/forward document caching so an old document cannot revive an approval. It supports native click, secret type, select, scroll and submit; keyboard simulation, scripted sites, frames, shadow DOM and screenshots are outside this adapter. Owner-only controls, their labels and label descendants have no executable target. Form documents are conservatively private regardless of claimed benign field labels; errors and aborted observations also retain taint. Effective form/window targets include submitter overrides and base targets. A current-page read accepts the origin only and never implies navigation. A private-session marker preserves taint after navigation without fabricating a current private-field count.

Serialization is process-local across all service/adapter instances naming the same environment. The host owns the browser in that process; this is not a distributed lock. Late observations reconcile before release. An adapter that never settles keeps its lane occupied; failed late privacy/approval bookkeeping fences the lane rather than reopening stale authority. Cancellation and read-only ledger inspection remain available.
