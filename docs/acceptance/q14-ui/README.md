# Q14 bounded room surface evidence

Run: `node scripts/ui-contracts/verify-member-rooms.mjs`.
Headless agent-browser, isolated worktree session, dark/light, 1440×900 and
390×844. Fixture transport only, no provider invocation or owner write endpoint.
Room fixtures are derived through `applyRoom` and checked by `validateRoom`, then
served through the existing Mission/read-state routes. Steps render in the B7
Work pane; the transcript renders in the conversation.

Each screen has the initial `.png`, `.snapshot.txt`, `.snapshot.json` and
`.contract.txt`, plus `-transcript.png` and `-mobile.png`. `interactions.json`
records the checks. B18 opens the price Work after capturing the member thread;
B22-room switches from the app tab back to the Work tab for transcript checks.
All eight runs passed visible inferred claims, quote display, escalation note,
expand/collapse, mobile overflow and close assertions.

| Screen | Required | Passed | Failures per theme |
|---|---:|---:|---:|
| B18 | 34 | 30 | 4 |
| B18-room-b | 69 | 29 | 40 |
| B22-room | 40 | 27 | 13 |
| B22-room-steps | 49 | 36 | 13 |

Full contracts do **not** pass. Remaining failures are shell/control, data,
role and ordering differences. The pane text-budget checks now have zero failures.
This is not a claim of complete prototype parity.

The initial capture opened legacy evidence and placed the transcript in the pane;
it was rejected by visual review. The regenerated capture and assertions require
B22-room-steps to show Read / Run tests / Check / Record in the B7 pane, with Stop
and the collapsed check bar. No legacy state, attempts, budgets, identifiers,
source-document/organization sections or inferred transcript are in that pane.
The transcript is in `#chat-log`, including its inferred provenance. The normal
step fixture no longer expands any evidence inspector. Deliberate result readers
and unknown-run closure controls are separately regression-tested.

Visually inspected the regenerated B22-room-steps dark desktop and B18-room-b
light desktop against `proto/render-out/self/B22-room-steps.png` and the supplied
B18-room-b artboard. The B22 app tab is also captured; the browser then returns to
the Work tab for the room-specific checks. These are fixture screenshots only.

The broader B7/B8 and B22 step-pane interaction regression also passed all 20
screen/theme runs with `node scripts/ui-contracts/verify-work-pane.mjs` after the
fix. See `work-pane-interactions.json`; this covers the check bar, deliberate
inspection, terminal states, unknown-state preservation, mobile width and close
focus. The changed files' copy-lint check reported zero blocking findings.
