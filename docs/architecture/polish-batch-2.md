# Polish batch 2

Scope: the supplied Polish2 brief, on main `e15b9c0`. Keep the approved B13,
B19, B23 and B7/B8 artboards and existing visual tokens. No new API, dependency,
scenario-specific producer, app catalog edit or browser-runtime edit.

- [x] Extend native General tests for visible pending saves and the existing
  approved unset label/options; retain readback, restart and unknown-outcome fences.
- [x] Extend Work room tests for one verdict value per checking row. Keep the
  count in the card header, and real evidence/times in their existing rows.
- [x] Correct General status spacing, unavailable app contrast, procedure chip
  typography and archive alignment, table caption/scroll affordance, and Korean
  wrapping using existing tokens and platform scrolling.
- [x] Capture before/after states in both themes, plus mobile and pending-save
  states. Compare approved artboards; remove only resolved allow-list entries.
- [x] Run focused tests and typecheck.
- [ ] Push one PR, then address CI and current-head Codex P1/P2 findings (maximum
  four review loops). The lead now authorizes merging main and the PR after six
  CI jobs pass, current-head Codex is clean, GitHub is mergeable and the contract
  diff against origin/main is empty.

Already implemented on current main, to verify without rewriting: real failed
check evidence (no invented business threshold), expand/collapse glyph switching,
event timestamps when stored, and distinct invalid/expired credential labels.
Reach: Settings, app Settings CSS, Work room rendering/CSS, their existing tests,
focused browser assertions and acceptance evidence. Stored state, commands,
credentials and execution ownership remain unchanged.

Lead correction: restore both General contracts byte-for-byte from origin/main.
Keep the approved briefing dash and off/low/high options disabled; no frequency
producer or saved selection is inferred. Restore all four installed-version
exceptions with their original reasons. A clearer unset label and a version
placeholder are proposals for the owner, not approved contract changes.
No synthetic check evidence or timestamps are introduced. Fixture captures prove UI behavior,
not live native/provider integration. Full suites and all contracts run in CI.

Korean wrapping follows [MDN word-break](https://developer.mozilla.org/en-US/docs/Web/CSS/word-break)
(`keep-all` retains words; long unbroken result bytes still have an overflow fallback).
