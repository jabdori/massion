# Contract baseline after E6c

Main `ac99f1da04ca51007223edb566e36d3b29933cb6` merged E6c (#120)
before the blocking baseline (#118). Its complete [CI capture](https://github.com/jabdori/massion/actions/runs/42657950604)
contains 150 screen/theme rows, 958 diagnostic occurrences, 18 new identities,
38 resolved exceptions and no infrastructure errors.

Use that complete capture with the existing removal-only regeneration command
first. Then admit only the 18 exact new identities with `--allow-additions
--reasons docs/acceptance/e6c/rebaseline-reasons.json`. Each reason links to the
[E6c residual ledger](../acceptance/e6c/README.md#post-merge-contract-identities).
Keep all other exception metadata and the original baseline source unchanged;
the refresh provenance is recorded here rather than relabeling older evidence.

The four B4 contract failures require a real browser page/snapshot producer;
checkout fields are not a substitute for page evidence. The B16-sent order
failure follows from the absent rounding proposal and its unread marker, not
from incorrectly ordered existing activity. Do not fabricate a proposal or move
unrelated unread state to satisfy the checker. These capability changes exceed
this baseline repair. Contracts, checker, fixtures and production UI stay intact.

Verify the final list against the complete CI capture and freshly capture B4,
B16, B16-later and B16-sent in both themes. Use the existing capture reader and
gate evaluator with only those eight screen/theme identities for the local
subset; the CLI intentionally requires complete coverage. Run gate unit tests
and typecheck locally; CI owns the full suite and fresh all-screen capture.
Deliver the requested PR and request `@codex review`; do not merge.
