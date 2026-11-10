# Team-room geometry evidence

The compact desktop layout now follows the actual room surface. Typed worker
tables use a 640px pane; source-backed app rooms retain the 600px pane. Both have
20px conversation gutters. Ordinary Work inspectors, expanded details, hidden
panes, other pages, and mobile overlays keep their existing layout.

At the 1440 × 900 reference viewport, both system themes measure:

| Surface | Main rectangle | Composer rectangle | Pane width |
| --- | --- | --- | --- |
| B18-room-b | `[300,44,500,856]` | `[320,808,460,78]` | 640 |
| B22-room | `[300,44,540,856]` | `[320,808,500,78]` | 600 |
| B22-room-steps | `[300,44,540,856]` | `[320,808,500,78]` | 600 |

The original eight geometry diagnostics were reproduced before the change and
removed from the allow-list after all eight disappeared. No screen contracts or
prototype sources changed. B7-churn, B8-fail, and B18 were also captured in both
themes: their geometry remains unchanged. Existing non-geometry residuals remain
in the allow-list, including two B18-room-b contract failures and its fixture gap.
This is geometry evidence, not a claim that every product capability is complete.

Verification:

- `node --test tests/work-room-visual.test.ts tests/surface-shell.test.ts`:
  79 passed. The new regression failed before implementation; an additional
  failure proved that closing an app tab must retain the source-backed layout.
- `npm run typecheck`: passed using Node 24.21.0.
- `node scripts/ui-contracts/run.mjs B18-room-b B22-room B22-room-steps B7-churn B8-fail B18`:
  12 captures, zero geometry failures and zero infrastructure errors.
- Headless agent-browser checked all three room flows in both themes: app/Work
  tab selection, app-tab closure followed by a redraw, switching from a table
  room to ordinary Work and back, widen/restore, hide/show, and 390px mobile
  overlays. Every flow submitted zero commands. See [interactions.json](interactions.json).
- All six desktop captures were compared with the approved artboards. The
  composer edges and pane split match; existing content differences remain
  outside this UI-only slice. The Impeccable detector returned no findings.

Screenshots: `screenshots/{dark,light}/{B18-room-b,B22-room,B22-room-steps}.png`.
Mobile examples: `screenshots/{dark,light}/{B18-room-b,B22-room-steps}-mobile.png`.
Exact browser measurements: `visual/{dark,light}/*.json`.

Full-suite and all-75-screen blocking verification run in CI. No real database,
model, browser-runtime producer, payment, member undo, or file-read completion
change is included. The PR must not be merged by this execution.
