# Conversation surface fidelity (E3b)

## Intent and boundaries

Match the approved conversation surfaces in `docs/product/screens` in dark and light system themes above E3a. The source of copy is `copy.ko.json`; measurements and colours come from `visual.json` through the generated tokens. Existing application commands, protocol generations, drain-aware owner writes and unknown-outcome guards remain authoritative.

Change the existing conversation panel and shell: composer, messages and their copy/scroll controls, Work/decision/exception/briefing cards, header and sidebar controls. Reuse current member settings, permission settings, Work tabs and draft handling. Do not restructure the Work pane (B7), results, schedules or settings pages; do not add APIs or fabricated provider outcomes.

## Plan and verification

1. Measure all requested B1/B2/B3/B4/B5/B6/B11/B16/B18/B21/B26 states with the existing isolated, headless agent-browser runner in both themes before changes.
2. Extend existing client tests first for composer controls, copy and scrolling, and shell controls. Preserve command identity, unknown delivery, feed replacement and stale-response tests.
3. Implement through existing DOM nodes, keyed cards and handlers. Keep unknown outcomes read-only: no retry or resend. Grow the editor to the approved 200px cap, then scroll; retain drafts and send-failure recovery.
4. Run focused tests, typecheck, source checks and the full test suite. Repeat the same screen runner after changes and inspect B2/B5/B11/B18 side-by-side pairs in both themes. Record remaining contract gaps honestly, including unavailable product behavior; never relax contracts to hide drift.
5. Commit, push and open an English PR with measurements and checked-in evidence pairs; do not merge.

## PR 106 completion pass

The initial 370 remaining diagnostics are an unfinished task, not an acceptance baseline. Classify each occurrence against saved snapshots, contracts, real host read shapes and approved artboard evidence before editing. Fix UI causes throughout the conversation/composer/cards/header/sidebar, repair fixture gaps that represent already-supported states, and regression-test demonstrated checker defects without weakening order, occurrence or budget rules. Approved wording absent from the copy table may be imported with the artboard ID as provenance. Only later Work-pane/page structure or a capability with no producing host path may remain, each with an explicit reason. Retain the original 44-run evidence and compare the final candidate in both themes; update PR 106 and request `@codex review` after pushing.
