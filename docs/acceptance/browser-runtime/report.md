# UI contracts

Mode: **REPORT-ONLY**. 2/6 screen/theme runs pass all measured checks; 4 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B15 | dark | 34 / 35 | 1 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B15.png) |
| B4 | dark | 35 / 35 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B4.png) |
| B7 | dark | 39 / 40 | 1 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B7.png) |
| B15 | light | 34 / 35 | 1 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B15.png) |
| B4 | light | 35 / 35 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B4.png) |
| B7 | light | 39 / 40 | 1 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B7.png) |

## B15 (dark)

[Snapshot](snapshots/dark/B15.txt) · [Checker](checks/dark/B15.txt) · [Screenshot](screenshots/dark/B15.png) · [Visual measurements](visual/dark/B15.json)

## B4 (dark)

[Snapshot](snapshots/dark/B4.txt) · [Checker](checks/dark/B4.txt) · [Screenshot](screenshots/dark/B4.png) · [Visual measurements](visual/dark/B4.json)

## B7 (dark)

[Snapshot](snapshots/dark/B7.txt) · [Checker](checks/dark/B7.txt) · [Screenshot](screenshots/dark/B7.png) · [Visual measurements](visual/dark/B7.json)
- Gap: No host producer supplies named business steps or per-step timestamps; browser/page-read telemetry is produced by BrowserSessions.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B15 (light)

[Snapshot](snapshots/light/B15.txt) · [Checker](checks/light/B15.txt) · [Screenshot](screenshots/light/B15.png) · [Visual measurements](visual/light/B15.json)

## B4 (light)

[Snapshot](snapshots/light/B4.txt) · [Checker](checks/light/B4.txt) · [Screenshot](screenshots/light/B4.png) · [Visual measurements](visual/light/B4.json)

## B7 (light)

[Snapshot](snapshots/light/B7.txt) · [Checker](checks/light/B7.txt) · [Screenshot](screenshots/light/B7.png) · [Visual measurements](visual/light/B7.json)
- Gap: No host producer supplies named business steps or per-step timestamps; browser/page-read telemetry is produced by BrowserSessions.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
