# File-read completion activity (R-Q)

Reuse the exact source pins and provider delivery claims introduced in R-N.
Record a host-owned `deliveredAt` only when a claimed file-input effect receives
a successful receipt. Keep legacy receipts untimed; never backfill from dispatch,
task settlement, a verdict, progress, or the current clock. Unknown and failed
receipts do not prove delivery. Preserve command replay and Record checksums.

The existing Work query projects one stable completion per non-skipped step.
Its declared paths select pinned file identities (document, path, content hash);
an omitted selection retains the runtime's existing all-pinned-files behavior.
Every identity needs a timed successful delivery to that exact step. Repeated
delivery counts each identity once and preserves its first delivery time. The
completion time is the latest of those first deliveries. Partial, absent, and
legacy untimed evidence produces no completion.

Render a separate sidebar activity link for each completed read step using the
approved `sidebar.link.05` copy. Open the original Work using the existing route.
The link remains available even if later work fails or becomes unknown; it does
not claim result acceptance. Query feed replacement retains existing stale-state
and request-generation fences.

Scope: source/query/sidebar code, backup validation, related tests and fixture
producers, six B7 completion-link exceptions, and browser evidence. Exclude
browser runtime, member undo/attribution, room geometry, typed payments, approved
screen contracts, real providers and deployment. Locally verify affected tests,
typecheck and the three screens in both themes; CI owns aggregate verification.
