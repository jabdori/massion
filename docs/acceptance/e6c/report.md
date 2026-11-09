# UI contracts

Mode: **REPORT-ONLY**. 0/8 screen/theme runs pass all measured checks; 8 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B4 | dark | 31 / 35 | 4 | 0 | 0 | 1 | 0 | [PNG](pairs/dark/B4.png) |
| B16 | dark | 21 / 22 | 1 | 0 | 0 | 1 | 0 | [PNG](pairs/dark/B16.png) |
| B16-sent | dark | 19 / 21 | 2 | 0 | 0 | 1 | 0 | [PNG](pairs/dark/B16-sent.png) |
| B16-later | dark | 20 / 21 | 1 | 0 | 0 | 1 | 0 | [PNG](pairs/dark/B16-later.png) |
| B4 | light | 31 / 35 | 4 | 0 | 0 | 1 | 0 | [PNG](pairs/light/B4.png) |
| B16 | light | 21 / 22 | 1 | 0 | 0 | 1 | 0 | [PNG](pairs/light/B16.png) |
| B16-sent | light | 19 / 21 | 2 | 0 | 0 | 1 | 0 | [PNG](pairs/light/B16-sent.png) |
| B16-later | light | 20 / 21 | 1 | 0 | 0 | 1 | 0 | [PNG](pairs/light/B16-later.png) |

## B4 (dark)

[Snapshot](snapshots/dark/B4.txt) · [Checker](checks/dark/B4.txt) · [Screenshot](screenshots/dark/B4.png) · [Visual measurements](visual/dark/B4.json)
- Gap: No browser page snapshot producer is installed; the browser tab shows unavailable and no checkout text fallback.

## B16 (dark)

[Snapshot](snapshots/dark/B16.txt) · [Checker](checks/dark/B16.txt) · [Screenshot](screenshots/dark/B16.png) · [Visual measurements](visual/dark/B16.json)
- Gap: The separate rounding-rule decision has no producer in E6c; its activity row remains absent.

## B16-sent (dark)

[Snapshot](snapshots/dark/B16-sent.txt) · [Checker](checks/dark/B16-sent.txt) · [Screenshot](screenshots/dark/B16-sent.png) · [Visual measurements](visual/dark/B16-sent.json)
- Gap: The separate rounding-rule decision has no producer in E6c; its activity row remains absent.

## B16-later (dark)

[Snapshot](snapshots/dark/B16-later.txt) · [Checker](checks/dark/B16-later.txt) · [Screenshot](screenshots/dark/B16-later.png) · [Visual measurements](visual/dark/B16-later.json)
- Gap: The separate rounding-rule decision has no producer in E6c; its activity row remains absent.

## B4 (light)

[Snapshot](snapshots/light/B4.txt) · [Checker](checks/light/B4.txt) · [Screenshot](screenshots/light/B4.png) · [Visual measurements](visual/light/B4.json)
- Gap: No browser page snapshot producer is installed; the browser tab shows unavailable and no checkout text fallback.

## B16 (light)

[Snapshot](snapshots/light/B16.txt) · [Checker](checks/light/B16.txt) · [Screenshot](screenshots/light/B16.png) · [Visual measurements](visual/light/B16.json)
- Gap: The separate rounding-rule decision has no producer in E6c; its activity row remains absent.

## B16-sent (light)

[Snapshot](snapshots/light/B16-sent.txt) · [Checker](checks/light/B16-sent.txt) · [Screenshot](screenshots/light/B16-sent.png) · [Visual measurements](visual/light/B16-sent.json)
- Gap: The separate rounding-rule decision has no producer in E6c; its activity row remains absent.

## B16-later (light)

[Snapshot](snapshots/light/B16-later.txt) · [Checker](checks/light/B16-later.txt) · [Screenshot](screenshots/light/B16-later.png) · [Visual measurements](visual/light/B16-later.json)
- Gap: The separate rounding-rule decision has no producer in E6c; its activity row remains absent.
