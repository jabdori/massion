# UI contracts

Mode: **REPORT-ONLY**. 2/16 screen/theme runs pass all measured checks; 14 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B13-general | dark | 20 / 21 | 1 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B13-general.png) |
| B13-general-restart | dark | 22 / 23 | 1 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B13-general-restart.png) |
| B23 | dark | 29 / 29 | 0 | 0 | 0 | 1 | 0 | [PNG](pairs/dark/B23.png) |
| B18-room-b | dark | 67 / 69 | 2 | 2 | 2 | 1 | 0 | [PNG](pairs/dark/B18-room-b.png) |
| B8-done | dark | 34 / 36 | 2 | 3 | 0 | 2 | 0 | [PNG](pairs/dark/B8-done.png) |
| B8-fail | dark | 36 / 36 | 0 | 3 | 0 | 2 | 0 | [PNG](pairs/dark/B8-fail.png) |
| B7-unknown | dark | 36 / 46 | 10 | 3 | 0 | 2 | 0 | [PNG](pairs/dark/B7-unknown.png) |
| B19-juno | dark | 37 / 37 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B19-juno.png) |
| B13-general | light | 20 / 21 | 1 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B13-general.png) |
| B13-general-restart | light | 22 / 23 | 1 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B13-general-restart.png) |
| B23 | light | 29 / 29 | 0 | 0 | 0 | 1 | 0 | [PNG](pairs/light/B23.png) |
| B18-room-b | light | 67 / 69 | 2 | 2 | 2 | 1 | 0 | [PNG](pairs/light/B18-room-b.png) |
| B8-done | light | 34 / 36 | 2 | 3 | 0 | 2 | 0 | [PNG](pairs/light/B8-done.png) |
| B8-fail | light | 36 / 36 | 0 | 3 | 0 | 2 | 0 | [PNG](pairs/light/B8-fail.png) |
| B7-unknown | light | 36 / 46 | 10 | 3 | 0 | 2 | 0 | [PNG](pairs/light/B7-unknown.png) |
| B19-juno | light | 37 / 37 | 0 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B19-juno.png) |

## B13-general (dark)

[Snapshot](snapshots/dark/B13-general.txt) · [Checker](checks/dark/B13-general.txt) · [Screenshot](screenshots/dark/B13-general.png) · [Visual measurements](visual/dark/B13-general.json)

## B13-general-restart (dark)

[Snapshot](snapshots/dark/B13-general-restart.txt) · [Checker](checks/dark/B13-general-restart.txt) · [Screenshot](screenshots/dark/B13-general-restart.png) · [Visual measurements](visual/dark/B13-general-restart.json)

## B23 (dark)

[Snapshot](snapshots/dark/B23.txt) · [Checker](checks/dark/B23.txt) · [Screenshot](screenshots/dark/B23.png) · [Visual measurements](visual/dark/B23.json)
- Gap: The host catalog contains only GitHub; the six other recommended apps have no installable packages.

## B18-room-b (dark)

[Snapshot](snapshots/dark/B18-room-b.txt) · [Checker](checks/dark/B18-room-b.txt) · [Screenshot](screenshots/dark/B18-room-b.png) · [Visual measurements](visual/dark/B18-room-b.json)
- Gap: The memory-candidate row belongs to R-D. Prices are controlled table fixture inputs, not external observations.
- Visual: region composer: [324,808,492,78] != [320,808,460,78] (2px tolerance)
- Visual: region main: [300,44,540,856] != [300,44,500,856] (2px tolerance)

## B8-done (dark)

[Snapshot](snapshots/dark/B8-done.txt) · [Checker](checks/dark/B8-done.txt) · [Screenshot](screenshots/dark/B8-done.png) · [Visual measurements](visual/dark/B8-done.json)
- Gap: Business procedures and typed counts exist for churn/pricing; browser/page-read telemetry is absent.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B8-fail (dark)

[Snapshot](snapshots/dark/B8-fail.txt) · [Checker](checks/dark/B8-fail.txt) · [Screenshot](screenshots/dark/B8-fail.png) · [Visual measurements](visual/dark/B8-fail.json)
- Gap: Business procedures and typed counts exist for churn/pricing; browser/page-read telemetry is absent.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B7-unknown (dark)

[Snapshot](snapshots/dark/B7-unknown.txt) · [Checker](checks/dark/B7-unknown.txt) · [Screenshot](screenshots/dark/B7-unknown.png) · [Visual measurements](visual/dark/B7-unknown.json)
- Gap: Business procedures and typed counts exist for churn/pricing; browser/page-read telemetry is absent.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B19-juno (dark)

[Snapshot](snapshots/dark/B19-juno.txt) · [Checker](checks/dark/B19-juno.txt) · [Screenshot](screenshots/dark/B19-juno.png) · [Visual measurements](visual/dark/B19-juno.json)

## B13-general (light)

[Snapshot](snapshots/light/B13-general.txt) · [Checker](checks/light/B13-general.txt) · [Screenshot](screenshots/light/B13-general.png) · [Visual measurements](visual/light/B13-general.json)

## B13-general-restart (light)

[Snapshot](snapshots/light/B13-general-restart.txt) · [Checker](checks/light/B13-general-restart.txt) · [Screenshot](screenshots/light/B13-general-restart.png) · [Visual measurements](visual/light/B13-general-restart.json)

## B23 (light)

[Snapshot](snapshots/light/B23.txt) · [Checker](checks/light/B23.txt) · [Screenshot](screenshots/light/B23.png) · [Visual measurements](visual/light/B23.json)
- Gap: The host catalog contains only GitHub; the six other recommended apps have no installable packages.

## B18-room-b (light)

[Snapshot](snapshots/light/B18-room-b.txt) · [Checker](checks/light/B18-room-b.txt) · [Screenshot](screenshots/light/B18-room-b.png) · [Visual measurements](visual/light/B18-room-b.json)
- Gap: The memory-candidate row belongs to R-D. Prices are controlled table fixture inputs, not external observations.
- Visual: region composer: [324,808,492,78] != [320,808,460,78] (2px tolerance)
- Visual: region main: [300,44,540,856] != [300,44,500,856] (2px tolerance)

## B8-done (light)

[Snapshot](snapshots/light/B8-done.txt) · [Checker](checks/light/B8-done.txt) · [Screenshot](screenshots/light/B8-done.png) · [Visual measurements](visual/light/B8-done.json)
- Gap: Business procedures and typed counts exist for churn/pricing; browser/page-read telemetry is absent.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B8-fail (light)

[Snapshot](snapshots/light/B8-fail.txt) · [Checker](checks/light/B8-fail.txt) · [Screenshot](screenshots/light/B8-fail.png) · [Visual measurements](visual/light/B8-fail.json)
- Gap: Business procedures and typed counts exist for churn/pricing; browser/page-read telemetry is absent.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B7-unknown (light)

[Snapshot](snapshots/light/B7-unknown.txt) · [Checker](checks/light/B7-unknown.txt) · [Screenshot](screenshots/light/B7-unknown.png) · [Visual measurements](visual/light/B7-unknown.json)
- Gap: Business procedures and typed counts exist for churn/pricing; browser/page-read telemetry is absent.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B19-juno (light)

[Snapshot](snapshots/light/B19-juno.txt) · [Checker](checks/light/B19-juno.txt) · [Screenshot](screenshots/light/B19-juno.png) · [Visual measurements](visual/light/B19-juno.json)
