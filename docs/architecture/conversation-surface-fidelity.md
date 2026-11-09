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

## Visual gate on PR 106

Apply the six approved artboard corrections: unfilled shield/permission/chevron control; rounded-square example member identities in fixtures; no selected-row shortcut or composer draft-copy ornament; keyboard-only token focus; management icon/divider and light popup shadow; plain centered dates; and the supported unknown-outcome presentation/closure review path. Keep owner-chosen shapes in production, unknown facts and times bound to recorded state, and all closure acknowledgement/identity guards. Do not turn the unavailable order-history capability into an invented success. Re-capture B2/B5/B11/B18 in both themes and recompute the scoped contract report before updating the PR and requesting review.

The same round includes the independent-review regressions: the shared thread-opening path refuses a switch while any visible `aria-modal` owns interaction, including shortcuts and direct callers; hidden dialogs do not block navigation. Active execution and check-wait elapsed clocks now share their eligibility predicate with the minute refresh in both the displayed turns and global Work list. Fake-clock checks cover an eventless waiting label advancing from one to three minutes, a global-only wait observing completion, and no command dispatch.

CI run 42534455306 exposed a shared empty-state layout regression: introducing `.chat-scroll` removed the old direct-child `.chat-log { flex:1 }` sizing. B1-signin has a real empty log, so the node existed but its height collapsed to zero and the unchanged 5s visible-element wait correctly failed. Make the scroll wrapper a flex column and let the log fill its remaining viewport. This restores stable empty conversations without fabricating sign-in UI, changing the documented capability gap, increasing timeouts, or downgrading infrastructure errors. The exact CI runner command is rerun across all 75 states in both themes, and the browser regression measures an empty nonzero log.
