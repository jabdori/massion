# UI contracts

Mode: **REPORT-ONLY**. 2/4 screen/theme runs pass all measured checks; 2 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B17-empty | dark | 15 / 15 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B17-empty.png) |
| B10-preview | dark | 30 / 31 | 2 | 3 | 0 | 0 | 0 | [PNG](pairs/dark/B10-preview.png) |
| B17-empty | light | 15 / 15 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B17-empty.png) |
| B10-preview | light | 30 / 31 | 2 | 3 | 0 | 0 | 0 | [PNG](pairs/light/B10-preview.png) |

## B17-empty (dark)

[Snapshot](snapshots/dark/B17-empty.txt) · [Checker](checks/dark/B17-empty.txt) · [Screenshot](screenshots/dark/B17-empty.png) · [Visual measurements](visual/dark/B17-empty.json)

## B10-preview (dark)

[Snapshot](snapshots/dark/B10-preview.txt) · [Checker](checks/dark/B10-preview.txt) · [Screenshot](screenshots/dark/B10-preview.png) · [Visual measurements](visual/dark/B10-preview.json)

## B17-empty (light)

[Snapshot](snapshots/light/B17-empty.txt) · [Checker](checks/light/B17-empty.txt) · [Screenshot](screenshots/light/B17-empty.png) · [Visual measurements](visual/light/B17-empty.json)

## B10-preview (light)

[Snapshot](snapshots/light/B10-preview.txt) · [Checker](checks/light/B10-preview.txt) · [Screenshot](screenshots/light/B10-preview.png) · [Visual measurements](visual/light/B10-preview.json)
