# UI contracts

Mode: **REPORT-ONLY**. 0/2 screen/theme runs pass all measured checks; 2 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B23 | dark | 29 / 29 | 0 | 0 | 0 | 1 | 0 | [PNG](pairs/dark/B23.png) |
| B23 | light | 29 / 29 | 0 | 0 | 0 | 1 | 0 | [PNG](pairs/light/B23.png) |

## B23 (dark)

[Snapshot](snapshots/dark/B23.txt) · [Checker](checks/dark/B23.txt) · [Screenshot](screenshots/dark/B23.png) · [Visual measurements](visual/dark/B23.json)
- Gap: The host catalog contains only GitHub; the six other recommended apps have no installable packages.

## B23 (light)

[Snapshot](snapshots/light/B23.txt) · [Checker](checks/light/B23.txt) · [Screenshot](screenshots/light/B23.png) · [Visual measurements](visual/light/B23.json)
- Gap: The host catalog contains only GitHub; the six other recommended apps have no installable packages.
