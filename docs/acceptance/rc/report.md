# UI contracts

Mode: **REPORT-ONLY**. 12/22 screen/theme runs pass all measured checks; 10 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B13 | dark | 21 / 22 | 1 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B13.png) |
| B13-devices | dark | 20 / 20 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B13-devices.png) |
| B14 | dark | 34 / 34 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B14.png) |
| B14-expired | dark | 34 / 34 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B14-expired.png) |
| B14-restart | dark | 36 / 36 | 0 | 0 | 0 | 1 | 0 | [PNG](pairs/dark/B14-restart.png) |
| B14-update | dark | 34 / 34 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B14-update.png) |
| B19 | dark | 34 / 43 | 9 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B19.png) |
| B19-juno | dark | 35 / 37 | 2 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B19-juno.png) |
| B23 | dark | 22 / 29 | 7 | 0 | 0 | 1 | 0 | [PNG](pairs/dark/B23.png) |
| B23-github | dark | 32 / 32 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B23-github.png) |
| B23-github-expired | dark | 33 / 33 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B23-github-expired.png) |
| B13 | light | 21 / 22 | 1 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B13.png) |
| B13-devices | light | 20 / 20 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B13-devices.png) |
| B14 | light | 34 / 34 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B14.png) |
| B14-expired | light | 34 / 34 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B14-expired.png) |
| B14-restart | light | 36 / 36 | 0 | 0 | 0 | 1 | 0 | [PNG](pairs/light/B14-restart.png) |
| B14-update | light | 34 / 34 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B14-update.png) |
| B19 | light | 34 / 43 | 9 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B19.png) |
| B19-juno | light | 35 / 37 | 2 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B19-juno.png) |
| B23 | light | 22 / 29 | 7 | 0 | 0 | 1 | 0 | [PNG](pairs/light/B23.png) |
| B23-github | light | 32 / 32 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B23-github.png) |
| B23-github-expired | light | 33 / 33 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B23-github-expired.png) |

## B13 (dark)

[Snapshot](snapshots/dark/B13.txt) · [Checker](checks/dark/B13.txt) · [Screenshot](screenshots/dark/B13.png) · [Visual measurements](visual/dark/B13.json)

## B13-devices (dark)

[Snapshot](snapshots/dark/B13-devices.txt) · [Checker](checks/dark/B13-devices.txt) · [Screenshot](screenshots/dark/B13-devices.png) · [Visual measurements](visual/dark/B13-devices.json)

## B14 (dark)

[Snapshot](snapshots/dark/B14.txt) · [Checker](checks/dark/B14.txt) · [Screenshot](screenshots/dark/B14.png) · [Visual measurements](visual/dark/B14.json)

## B14-expired (dark)

[Snapshot](snapshots/dark/B14-expired.txt) · [Checker](checks/dark/B14-expired.txt) · [Screenshot](screenshots/dark/B14-expired.png) · [Visual measurements](visual/dark/B14-expired.json)

## B14-restart (dark)

[Snapshot](snapshots/dark/B14-restart.txt) · [Checker](checks/dark/B14-restart.txt) · [Screenshot](screenshots/dark/B14-restart.png) · [Visual measurements](visual/dark/B14-restart.json)
- Gap: A trusted host produces restart-required state; no restart executor is installed.

## B14-update (dark)

[Snapshot](snapshots/dark/B14-update.txt) · [Checker](checks/dark/B14-update.txt) · [Screenshot](screenshots/dark/B14-update.png) · [Visual measurements](visual/dark/B14-update.json)

## B19 (dark)

[Snapshot](snapshots/dark/B19.txt) · [Checker](checks/dark/B19.txt) · [Screenshot](screenshots/dark/B19.png) · [Visual measurements](visual/dark/B19.json)

## B19-juno (dark)

[Snapshot](snapshots/dark/B19-juno.txt) · [Checker](checks/dark/B19-juno.txt) · [Screenshot](screenshots/dark/B19-juno.png) · [Visual measurements](visual/dark/B19-juno.json)

## B23 (dark)

[Snapshot](snapshots/dark/B23.txt) · [Checker](checks/dark/B23.txt) · [Screenshot](screenshots/dark/B23.png) · [Visual measurements](visual/dark/B23.json)
- Gap: The host catalog contains only GitHub; the six other recommended apps have no installable packages.

## B23-github (dark)

[Snapshot](snapshots/dark/B23-github.txt) · [Checker](checks/dark/B23-github.txt) · [Screenshot](screenshots/dark/B23-github.png) · [Visual measurements](visual/dark/B23-github.json)

## B23-github-expired (dark)

[Snapshot](snapshots/dark/B23-github-expired.txt) · [Checker](checks/dark/B23-github-expired.txt) · [Screenshot](screenshots/dark/B23-github-expired.png) · [Visual measurements](visual/dark/B23-github-expired.json)

## B13 (light)

[Snapshot](snapshots/light/B13.txt) · [Checker](checks/light/B13.txt) · [Screenshot](screenshots/light/B13.png) · [Visual measurements](visual/light/B13.json)

## B13-devices (light)

[Snapshot](snapshots/light/B13-devices.txt) · [Checker](checks/light/B13-devices.txt) · [Screenshot](screenshots/light/B13-devices.png) · [Visual measurements](visual/light/B13-devices.json)

## B14 (light)

[Snapshot](snapshots/light/B14.txt) · [Checker](checks/light/B14.txt) · [Screenshot](screenshots/light/B14.png) · [Visual measurements](visual/light/B14.json)

## B14-expired (light)

[Snapshot](snapshots/light/B14-expired.txt) · [Checker](checks/light/B14-expired.txt) · [Screenshot](screenshots/light/B14-expired.png) · [Visual measurements](visual/light/B14-expired.json)

## B14-restart (light)

[Snapshot](snapshots/light/B14-restart.txt) · [Checker](checks/light/B14-restart.txt) · [Screenshot](screenshots/light/B14-restart.png) · [Visual measurements](visual/light/B14-restart.json)
- Gap: A trusted host produces restart-required state; no restart executor is installed.

## B14-update (light)

[Snapshot](snapshots/light/B14-update.txt) · [Checker](checks/light/B14-update.txt) · [Screenshot](screenshots/light/B14-update.png) · [Visual measurements](visual/light/B14-update.json)

## B19 (light)

[Snapshot](snapshots/light/B19.txt) · [Checker](checks/light/B19.txt) · [Screenshot](screenshots/light/B19.png) · [Visual measurements](visual/light/B19.json)

## B19-juno (light)

[Snapshot](snapshots/light/B19-juno.txt) · [Checker](checks/light/B19-juno.txt) · [Screenshot](screenshots/light/B19-juno.png) · [Visual measurements](visual/light/B19-juno.json)

## B23 (light)

[Snapshot](snapshots/light/B23.txt) · [Checker](checks/light/B23.txt) · [Screenshot](screenshots/light/B23.png) · [Visual measurements](visual/light/B23.json)
- Gap: The host catalog contains only GitHub; the six other recommended apps have no installable packages.

## B23-github (light)

[Snapshot](snapshots/light/B23-github.txt) · [Checker](checks/light/B23-github.txt) · [Screenshot](screenshots/light/B23-github.png) · [Visual measurements](visual/light/B23-github.json)

## B23-github-expired (light)

[Snapshot](snapshots/light/B23-github-expired.txt) · [Checker](checks/light/B23-github-expired.txt) · [Screenshot](screenshots/light/B23-github-expired.png) · [Visual measurements](visual/light/B23-github-expired.json)
