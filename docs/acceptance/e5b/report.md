# UI contracts

Mode: **REPORT-ONLY**. 18/22 screen/theme runs pass all measured checks; 4 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B24 | dark | 23 / 23 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B24.png) |
| B24-done | dark | 24 / 24 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B24-done.png) |
| B24-later | dark | 23 / 23 | 0 | 1 | 0 | 0 | 0 | [PNG](pairs/dark/B24-later.png) |
| B25 | dark | 28 / 28 | 0 | 1 | 0 | 0 | 0 | [PNG](pairs/dark/B25.png) |
| B25-done | dark | 27 / 27 | 0 | 1 | 0 | 0 | 0 | [PNG](pairs/dark/B25-done.png) |
| B25-later | dark | 27 / 27 | 0 | 1 | 0 | 0 | 0 | [PNG](pairs/dark/B25-later.png) |
| B24-connect | dark | 23 / 23 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B24-connect.png) |
| B24-connect-token | dark | 28 / 28 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B24-connect-token.png) |
| B24-connect-connected | dark | 23 / 23 | 0 | 3 | 0 | 1 | 0 | [PNG](pairs/dark/B24-connect-connected.png) |
| B24-connect-later | dark | 22 / 22 | 0 | 3 | 0 | 1 | 0 | [PNG](pairs/dark/B24-connect-later.png) |
| B24-connect-mail | dark | 23 / 23 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B24-connect-mail.png) |
| B24 | light | 23 / 23 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B24.png) |
| B24-done | light | 24 / 24 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B24-done.png) |
| B24-later | light | 23 / 23 | 0 | 1 | 0 | 0 | 0 | [PNG](pairs/light/B24-later.png) |
| B25 | light | 28 / 28 | 0 | 1 | 0 | 0 | 0 | [PNG](pairs/light/B25.png) |
| B25-done | light | 27 / 27 | 0 | 1 | 0 | 0 | 0 | [PNG](pairs/light/B25-done.png) |
| B25-later | light | 27 / 27 | 0 | 1 | 0 | 0 | 0 | [PNG](pairs/light/B25-later.png) |
| B24-connect | light | 23 / 23 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B24-connect.png) |
| B24-connect-token | light | 28 / 28 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B24-connect-token.png) |
| B24-connect-connected | light | 23 / 23 | 0 | 3 | 0 | 1 | 0 | [PNG](pairs/light/B24-connect-connected.png) |
| B24-connect-later | light | 22 / 22 | 0 | 3 | 0 | 1 | 0 | [PNG](pairs/light/B24-connect-later.png) |
| B24-connect-mail | light | 23 / 23 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B24-connect-mail.png) |

## B24 (dark)

[Snapshot](snapshots/dark/B24.txt) · [Checker](checks/dark/B24.txt) · [Screenshot](screenshots/dark/B24.png) · [Visual measurements](visual/dark/B24.json)

## B24-done (dark)

[Snapshot](snapshots/dark/B24-done.txt) · [Checker](checks/dark/B24-done.txt) · [Screenshot](screenshots/dark/B24-done.png) · [Visual measurements](visual/dark/B24-done.json)

## B24-later (dark)

[Snapshot](snapshots/dark/B24-later.txt) · [Checker](checks/dark/B24-later.txt) · [Screenshot](screenshots/dark/B24-later.png) · [Visual measurements](visual/dark/B24-later.json)

## B25 (dark)

[Snapshot](snapshots/dark/B25.txt) · [Checker](checks/dark/B25.txt) · [Screenshot](screenshots/dark/B25.png) · [Visual measurements](visual/dark/B25.json)

## B25-done (dark)

[Snapshot](snapshots/dark/B25-done.txt) · [Checker](checks/dark/B25-done.txt) · [Screenshot](screenshots/dark/B25-done.png) · [Visual measurements](visual/dark/B25-done.json)

## B25-later (dark)

[Snapshot](snapshots/dark/B25-later.txt) · [Checker](checks/dark/B25-later.txt) · [Screenshot](screenshots/dark/B25-later.png) · [Visual measurements](visual/dark/B25-later.json)

## B24-connect (dark)

[Snapshot](snapshots/dark/B24-connect.txt) · [Checker](checks/dark/B24-connect.txt) · [Screenshot](screenshots/dark/B24-connect.png) · [Visual measurements](visual/dark/B24-connect.json)

## B24-connect-token (dark)

[Snapshot](snapshots/dark/B24-connect-token.txt) · [Checker](checks/dark/B24-connect-token.txt) · [Screenshot](screenshots/dark/B24-connect-token.png) · [Visual measurements](visual/dark/B24-connect-token.json)

## B24-connect-connected (dark)

[Snapshot](snapshots/dark/B24-connect-connected.txt) · [Checker](checks/dark/B24-connect-connected.txt) · [Screenshot](screenshots/dark/B24-connect-connected.png) · [Visual measurements](visual/dark/B24-connect-connected.json)
- Gap: The read-only contract host loads the connected result directly. The E5b acceptance harness proves the token-submit transition using a fixture command response, not a real account.

## B24-connect-later (dark)

[Snapshot](snapshots/dark/B24-connect-later.txt) · [Checker](checks/dark/B24-connect-later.txt) · [Screenshot](screenshots/dark/B24-connect-later.png) · [Visual measurements](visual/dark/B24-connect-later.json)
- Gap: The read-only contract host loads the deferred result directly. The E5b acceptance harness proves Later and Ask again through the decision endpoint.

## B24-connect-mail (dark)

[Snapshot](snapshots/dark/B24-connect-mail.txt) · [Checker](checks/dark/B24-connect-mail.txt) · [Screenshot](screenshots/dark/B24-connect-mail.png) · [Visual measurements](visual/dark/B24-connect-mail.json)

## B24 (light)

[Snapshot](snapshots/light/B24.txt) · [Checker](checks/light/B24.txt) · [Screenshot](screenshots/light/B24.png) · [Visual measurements](visual/light/B24.json)

## B24-done (light)

[Snapshot](snapshots/light/B24-done.txt) · [Checker](checks/light/B24-done.txt) · [Screenshot](screenshots/light/B24-done.png) · [Visual measurements](visual/light/B24-done.json)

## B24-later (light)

[Snapshot](snapshots/light/B24-later.txt) · [Checker](checks/light/B24-later.txt) · [Screenshot](screenshots/light/B24-later.png) · [Visual measurements](visual/light/B24-later.json)

## B25 (light)

[Snapshot](snapshots/light/B25.txt) · [Checker](checks/light/B25.txt) · [Screenshot](screenshots/light/B25.png) · [Visual measurements](visual/light/B25.json)

## B25-done (light)

[Snapshot](snapshots/light/B25-done.txt) · [Checker](checks/light/B25-done.txt) · [Screenshot](screenshots/light/B25-done.png) · [Visual measurements](visual/light/B25-done.json)

## B25-later (light)

[Snapshot](snapshots/light/B25-later.txt) · [Checker](checks/light/B25-later.txt) · [Screenshot](screenshots/light/B25-later.png) · [Visual measurements](visual/light/B25-later.json)

## B24-connect (light)

[Snapshot](snapshots/light/B24-connect.txt) · [Checker](checks/light/B24-connect.txt) · [Screenshot](screenshots/light/B24-connect.png) · [Visual measurements](visual/light/B24-connect.json)

## B24-connect-token (light)

[Snapshot](snapshots/light/B24-connect-token.txt) · [Checker](checks/light/B24-connect-token.txt) · [Screenshot](screenshots/light/B24-connect-token.png) · [Visual measurements](visual/light/B24-connect-token.json)

## B24-connect-connected (light)

[Snapshot](snapshots/light/B24-connect-connected.txt) · [Checker](checks/light/B24-connect-connected.txt) · [Screenshot](screenshots/light/B24-connect-connected.png) · [Visual measurements](visual/light/B24-connect-connected.json)
- Gap: The read-only contract host loads the connected result directly. The E5b acceptance harness proves the token-submit transition using a fixture command response, not a real account.

## B24-connect-later (light)

[Snapshot](snapshots/light/B24-connect-later.txt) · [Checker](checks/light/B24-connect-later.txt) · [Screenshot](screenshots/light/B24-connect-later.png) · [Visual measurements](visual/light/B24-connect-later.json)
- Gap: The read-only contract host loads the deferred result directly. The E5b acceptance harness proves Later and Ask again through the decision endpoint.

## B24-connect-mail (light)

[Snapshot](snapshots/light/B24-connect-mail.txt) · [Checker](checks/light/B24-connect-mail.txt) · [Screenshot](screenshots/light/B24-connect-mail.png) · [Visual measurements](visual/light/B24-connect-mail.json)
