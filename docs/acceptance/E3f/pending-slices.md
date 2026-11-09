# Pending-slice residual ownership

The lead explicitly authorized the following ownership-based reasons for existing
unclassified diagnostics in the pinned E3f main baseline. `pending-slice` records
the open slice responsible for resolution; it is not a completed capability or
permission to add new diagnostics. Counts below cover both themes and all diagnostic
kinds. The original approval covered 244 unclassified occurrences; the lead
subsequently authorized the four exact B24-connect-mail occurrences below.

## E5b

Resolution in PR #114: all 154 E5b allowances are removed after fresh 22-run capture and scoped blocking-gate verification. See [the E5b gate record](../e5b/allow-list-follow-up/README.md). Remaining data-producing limitations are retained separately in its residual ledger, not hidden by UI exceptions.

- Screens: `B24*`, `B25*`.
- Owner: [E5b PR #114](https://github.com/jabdori/massion/pull/114),
  `feat/mcp-apps` (open when checked).
- Pending-slice occurrences: 154 (150 original, four explicitly authorized below).
- Reason: The open MCP apps/connect-card slice owns these screen failures and gaps.

### Mail connection follow-up

The lead explicitly assigned these four remaining identities to E5b PR #114,
using the same pending-slice classification as the other B24 entries:

| Screen | Theme | Kind | Normalized diagnostic | Occurrence |
| --- | --- | --- | --- | ---: |
| B24-connect-mail | dark | contract | missing header button "더 보기" | 1 |
| B24-connect-mail | dark | contract | role conversation button "연결" (text exists without the required role) | 1 |
| B24-connect-mail | light | contract | missing header button "더 보기" | 1 |
| B24-connect-mail | light | contract | role conversation button "연결" (text exists without the required role) | 1 |

[mail-pending.json](mail-pending.json) supplies the exact regeneration reasons.
These are assigned residuals, not repaired controls. Remove each exception when
the owning slice resolves it; no wildcard waiver is added for future diagnostics.

## E7

- Screens: `B1-signin`, `B1-first*`.
- Owner: `feat/first-experience`, now
  [E7 PR #119](https://github.com/jabdori/massion/pull/119) (now merged).
- Original pending-slice occurrences: 24; current occurrences: zero.
- The complete main CI capture after landing resolves all 24 sign-in and
  first-work exceptions. Removal-only regeneration removed them; the original
  ownership approval does not authorize new failures.

## E8

- Screen: `B26` exactly; this decision does not add a `B26*` wildcard.
- Owner: [E8 PR #117](https://github.com/jabdori/massion/pull/117),
  `feat/monthly-budget` (open when checked).
- Pending-slice occurrences: 2.
- Reason: The open monthly-budget slice owns these budget-screen failures.

## Landing and removal

Each owning slice must remove its resolved entries when it lands. Run a fresh
complete capture, then `node scripts/ui-contracts/gate.ts --update`; the stale-entry
rule rejects any retained entry whose diagnostic no longer occurs. Slice ownership
alone never permits a resolved exception to remain or a new diagnostic to be added.

The lead initially kept `B22-room`, `B22-room-steps`, `B7-churn`, `B8-done`,
`B8-fail` and `B15` unclassified (68 occurrences) for another agent's ledger/fixes.
That work landed in [PR #121](https://github.com/jabdori/massion/pull/121), main
`dd0c48b7311560e9eb0576e2624b6c605d59de13`, and was merged into this branch without
rewriting published history. Its [residual ledger](../room-residuals/README.md)
supplies the reasons for remaining room/browser diagnostics; the refreshed E3f
baseline uses the complete CI capture from that main commit.

The latest refresh uses main `e6cd313b16def56dcc596878cadbdcf56876d6e1` and
[CI run 42653256831](https://github.com/jabdori/massion/actions/runs/42653256831).
It retains all 36 live room-ledger entries and admits the 22 exact
[pane residuals](../pane-step-times/remaining.json) from
[PR #122](https://github.com/jabdori/massion/pull/122). After removing E7's 24
resolved pending entries and adding the four newly authorized E5b occurrences,
156 pending entries remain (154 E5b, two E8). No unclassified occurrence remains
in this pinned capture. Historical ownership alone is not a blanket waiver.
