# UI contracts

Mode: **REPORT-ONLY**. 4/8 screen/theme runs pass all measured checks; 4 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B17-empty | dark | 15 / 15 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B17-empty.png) |
| B22 | dark | 20 / 20 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B22.png) |
| B22-room | dark | 34 / 40 | 6 | 0 | 1 | 0 | 0 | [PNG](pairs/dark/B22-room.png) |
| B22-room-steps | dark | 48 / 49 | 1 | 0 | 1 | 0 | 0 | [PNG](pairs/dark/B22-room-steps.png) |
| B17-empty | light | 15 / 15 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B17-empty.png) |
| B22 | light | 20 / 20 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B22.png) |
| B22-room | light | 34 / 40 | 6 | 0 | 1 | 0 | 0 | [PNG](pairs/light/B22-room.png) |
| B22-room-steps | light | 48 / 49 | 1 | 0 | 1 | 0 | 0 | [PNG](pairs/light/B22-room-steps.png) |

## B17-empty (dark)

[Snapshot](snapshots/dark/B17-empty.txt) · [Checker](checks/dark/B17-empty.txt) · [Screenshot](screenshots/dark/B17-empty.png) · [Visual measurements](visual/dark/B17-empty.json)

## B22 (dark)

[Snapshot](snapshots/dark/B22.txt) · [Checker](checks/dark/B22.txt) · [Screenshot](screenshots/dark/B22.png) · [Visual measurements](visual/dark/B22.json)

## B22-room (dark)

[Snapshot](snapshots/dark/B22-room.txt) · [Checker](checks/dark/B22-room.txt) · [Screenshot](screenshots/dark/B22-room.png) · [Visual measurements](visual/dark/B22-room.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)

## B22-room-steps (dark)

[Snapshot](snapshots/dark/B22-room-steps.txt) · [Checker](checks/dark/B22-room-steps.txt) · [Screenshot](screenshots/dark/B22-room-steps.png) · [Visual measurements](visual/dark/B22-room-steps.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)

## B17-empty (light)

[Snapshot](snapshots/light/B17-empty.txt) · [Checker](checks/light/B17-empty.txt) · [Screenshot](screenshots/light/B17-empty.png) · [Visual measurements](visual/light/B17-empty.json)

## B22 (light)

[Snapshot](snapshots/light/B22.txt) · [Checker](checks/light/B22.txt) · [Screenshot](screenshots/light/B22.png) · [Visual measurements](visual/light/B22.json)

## B22-room (light)

[Snapshot](snapshots/light/B22-room.txt) · [Checker](checks/light/B22-room.txt) · [Screenshot](screenshots/light/B22-room.png) · [Visual measurements](visual/light/B22-room.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)

## B22-room-steps (light)

[Snapshot](snapshots/light/B22-room-steps.txt) · [Checker](checks/light/B22-room-steps.txt) · [Screenshot](screenshots/light/B22-room-steps.png) · [Visual measurements](visual/light/B22-room-steps.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)
