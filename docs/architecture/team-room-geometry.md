# Team-room composition geometry

Match the existing table-result and app-backed team-room surfaces to their
approved contracts without changing producers, copy, or screen contracts.
The shared Work inspector keeps its current geometry.

Use the actual Work surface as the layout boundary: a room, a settled typed
worker table, or a validated pinned app review source identifies a team room.
This is independent of titles, screen IDs, and whether its app tab is open.
A visible compact worker table
needs a 640px pane (500px conversation at the 1440px reference viewport), while
an app-backed room keeps the existing 600px pane. Both use 20px conversation
gutters. Scope these rules to the visible pane and compact desktop layout so
hidden tables, other pages, expanded details, and mobile overlays do not resize
the conversation. Reuse the existing spacing tokens and pane sizing rule.

Verify the original failures with the existing browser contract runner before
editing CSS. Then remove only the eight resolved geometry exceptions, repeat
the affected contracts in both themes, and inspect table/app/step-note rooms
alongside unchanged Work inspectors and ordinary member conversations. Exercise
tab switches, pane expansion, closing, and mobile layouts headlessly. Run focused
surface tests and typecheck locally; CI owns the complete screen catalog and
test suite. Push a PR and follow CI and head-bound Codex review without merging.
