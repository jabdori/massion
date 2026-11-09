# Work room step times and output order

Scope: the 22 unclassified occurrences from blocking-contract PR #118 on main
`dd0c48b`, implemented as a separate PR on current main `3ffdf51`.

Read Q13's actual `TeamStep`, `Task`, delegation, effect admission and settlement
before displaying a time. None stores a per-step timestamp. Work start/end and
Representative handoff/conversation times belong to those events, not worker
steps. Preserve their original locations and never copy them into step rows.
Record the exact remaining time occurrences and producing-path evidence in a
residual ledger. No new persistence, runtime command or inferred time field.

The compact Q13 worker-result blocks are outputs. Their role chip must precede
the producing member, matching the result rows in the B7-fail contract. Keep the
participant list's member/roles/independent-Check order and the flat procedure
rows unchanged. Legacy B7-fail fixtures have no named worker steps; correct output
ordering cannot manufacture a research worker or a five-message room history.

Verification: first fail the existing Q13 output-order assertion, then make the
small renderer change. Check related pane/team/source tests and typecheck. Run
only the affected B7/B7-done/B7-fail/B7-unknown contracts in both themes, plus a
Q13 worker-result fixture for real browser order and narrow/wide/mobile behavior.
Keep contract thresholds and fixtures intact; enumerate every unclassified
occurrence that remains, with evidence, rather than claiming a full contract pass.
Push and request Codex review; never merge. PR #118's full baseline refresh waits
for this PR to land and a complete new main CI capture.
