# UI contracts

Mode: **REPORT-ONLY**. 0/4 screen/theme runs pass all measured checks; 4 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B26 | dark | 25 / 27 | 2 | 3 | 0 | 1 | 0 | [PNG](pairs/dark/B26.png) |
| B26-later | dark | 26 / 27 | 1 | 3 | 0 | 1 | 0 | [PNG](pairs/dark/B26-later.png) |
| B26 | light | 25 / 27 | 2 | 3 | 0 | 1 | 0 | [PNG](pairs/light/B26.png) |
| B26-later | light | 26 / 27 | 1 | 3 | 0 | 1 | 0 | [PNG](pairs/light/B26-later.png) |

## B26 (dark)

[Snapshot](snapshots/dark/B26.txt) · [Checker](checks/dark/B26.txt) · [Screenshot](screenshots/dark/B26.png) · [Visual measurements](visual/dark/B26.json)
- Gap: No monthly budget aggregate, current/increased currency projection, budget-paused Work list or budget decision/defer/reopen producer exists. Existing work-budget edits apply only to fresh unstarted Work, not the stopped monthly-budget scenario. No approval or budget-wait separator is fabricated.

## B26-later (dark)

[Snapshot](snapshots/dark/B26-later.txt) · [Checker](checks/dark/B26-later.txt) · [Screenshot](screenshots/dark/B26-later.png) · [Visual measurements](visual/dark/B26-later.json)
- Gap: The host routes owner decisions only to members, apps and skills; no budget-waiting admission, increase, deferral or reopen state producer exists. No corresponding decision or outcome is fabricated.

## B26 (light)

[Snapshot](snapshots/light/B26.txt) · [Checker](checks/light/B26.txt) · [Screenshot](screenshots/light/B26.png) · [Visual measurements](visual/light/B26.json)
- Gap: No monthly budget aggregate, current/increased currency projection, budget-paused Work list or budget decision/defer/reopen producer exists. Existing work-budget edits apply only to fresh unstarted Work, not the stopped monthly-budget scenario. No approval or budget-wait separator is fabricated.

## B26-later (light)

[Snapshot](snapshots/light/B26-later.txt) · [Checker](checks/light/B26-later.txt) · [Screenshot](screenshots/light/B26-later.png) · [Visual measurements](visual/light/B26-later.json)
- Gap: The host routes owner decisions only to members, apps and skills; no budget-waiting admission, increase, deferral or reopen state producer exists. No corresponding decision or outcome is fabricated.
