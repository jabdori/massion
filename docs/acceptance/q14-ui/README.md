# Q14 bounded room surface evidence

Run: `node scripts/ui-contracts/verify-member-rooms.mjs`.
Headless agent-browser, isolated worktree session, dark/light, 1440×900 and
390×844. Fixture transport only, no provider invocation or owner write endpoint.
Room fixtures are derived through `applyRoom` and checked by `validateRoom`, then
served through the existing Mission/read-state routes and Work pane.

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
| B22-room-steps | 49 | 34 | 18 |

Full contracts do **not** pass. Failures include existing shell/control and data
capabilities plus text-budget differences when the added transcript and evidence
are visible. This run does not establish a baseline delta. Comparing B18-room-b
with the supplied artboard confirms the retained shell colors and pane structure,
but not its task progression, timestamps, participant routing or result table.
The Q14 slice renders the stored claims; full screen parity remains follow-up.

Visual inspection: B18-room-b dark desktop and light mobile, alongside the
supplied `proto/render-out/b18/B18-room-b.png`. Transcript text remains readable,
wraps within the pane and does not appear as accepted checking evidence. The
checker and stop control stay distinct. Screenshots are fixture evidence only.
