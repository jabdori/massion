# UI contracts

Mode: **REPORT-ONLY**. 0/26 screen/theme runs pass all measured checks; 26 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B7 | dark | 39 / 40 | 1 | 2 | 0 | 2 | 0 | [PNG](pairs/dark/B7.png) |
| B7-churn | dark | 53 / 74 | 21 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B7-churn.png) |
| B7-done | dark | 34 / 47 | 13 | 2 | 0 | 2 | 0 | [PNG](pairs/dark/B7-done.png) |
| B7-fail | dark | 41 / 78 | 37 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B7-fail.png) |
| B7-unknown | dark | 35 / 46 | 11 | 2 | 0 | 2 | 0 | [PNG](pairs/dark/B7-unknown.png) |
| B8 | dark | 28 / 31 | 3 | 2 | 0 | 2 | 0 | [PNG](pairs/dark/B8.png) |
| B8-done | dark | 33 / 36 | 3 | 2 | 0 | 2 | 0 | [PNG](pairs/dark/B8-done.png) |
| B8-fail | dark | 34 / 36 | 2 | 3 | 0 | 3 | 0 | [PNG](pairs/dark/B8-fail.png) |
| B8-unknown | dark | 30 / 36 | 6 | 2 | 0 | 2 | 0 | [PNG](pairs/dark/B8-unknown.png) |
| B18 | dark | 30 / 34 | 4 | 2 | 0 | 1 | 0 | [PNG](pairs/dark/B18.png) |
| B18-room-b | dark | 56 / 69 | 13 | 2 | 2 | 1 | 0 | [PNG](pairs/dark/B18-room-b.png) |
| B22-room | dark | 34 / 40 | 6 | 0 | 1 | 0 | 0 | [PNG](pairs/dark/B22-room.png) |
| B22-room-steps | dark | 48 / 49 | 1 | 0 | 1 | 0 | 0 | [PNG](pairs/dark/B22-room-steps.png) |
| B7 | light | 39 / 40 | 1 | 2 | 0 | 2 | 0 | [PNG](pairs/light/B7.png) |
| B7-churn | light | 53 / 74 | 21 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B7-churn.png) |
| B7-done | light | 34 / 47 | 13 | 2 | 0 | 2 | 0 | [PNG](pairs/light/B7-done.png) |
| B7-fail | light | 41 / 78 | 37 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B7-fail.png) |
| B7-unknown | light | 35 / 46 | 11 | 2 | 0 | 2 | 0 | [PNG](pairs/light/B7-unknown.png) |
| B8 | light | 28 / 31 | 3 | 2 | 0 | 2 | 0 | [PNG](pairs/light/B8.png) |
| B8-done | light | 33 / 36 | 3 | 2 | 0 | 2 | 0 | [PNG](pairs/light/B8-done.png) |
| B8-fail | light | 34 / 36 | 2 | 3 | 0 | 3 | 0 | [PNG](pairs/light/B8-fail.png) |
| B8-unknown | light | 30 / 36 | 6 | 2 | 0 | 2 | 0 | [PNG](pairs/light/B8-unknown.png) |
| B18 | light | 30 / 34 | 4 | 2 | 0 | 1 | 0 | [PNG](pairs/light/B18.png) |
| B18-room-b | light | 56 / 69 | 13 | 2 | 2 | 1 | 0 | [PNG](pairs/light/B18-room-b.png) |
| B22-room | light | 34 / 40 | 6 | 0 | 1 | 0 | 0 | [PNG](pairs/light/B22-room.png) |
| B22-room-steps | light | 48 / 49 | 1 | 0 | 1 | 0 | 0 | [PNG](pairs/light/B22-room-steps.png) |

## B7 (dark)

[Snapshot](snapshots/dark/B7.txt) · [Checker](checks/dark/B7.txt) · [Screenshot](screenshots/dark/B7.png) · [Visual measurements](visual/dark/B7.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B7-churn (dark)

[Snapshot](snapshots/dark/B7-churn.txt) · [Checker](checks/dark/B7-churn.txt) · [Screenshot](screenshots/dark/B7-churn.png) · [Visual measurements](visual/dark/B7-churn.json)
- Gap: No browser/page-read telemetry is produced by these fixture text Works.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B7-done (dark)

[Snapshot](snapshots/dark/B7-done.txt) · [Checker](checks/dark/B7-done.txt) · [Screenshot](screenshots/dark/B7-done.png) · [Visual measurements](visual/dark/B7-done.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B7-fail (dark)

[Snapshot](snapshots/dark/B7-fail.txt) · [Checker](checks/dark/B7-fail.txt) · [Screenshot](screenshots/dark/B7-fail.png) · [Visual measurements](visual/dark/B7-fail.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B7-unknown (dark)

[Snapshot](snapshots/dark/B7-unknown.txt) · [Checker](checks/dark/B7-unknown.txt) · [Screenshot](screenshots/dark/B7-unknown.png) · [Visual measurements](visual/dark/B7-unknown.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B8 (dark)

[Snapshot](snapshots/dark/B8.txt) · [Checker](checks/dark/B8.txt) · [Screenshot](screenshots/dark/B8.png) · [Visual measurements](visual/dark/B8.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B8-done (dark)

[Snapshot](snapshots/dark/B8-done.txt) · [Checker](checks/dark/B8-done.txt) · [Screenshot](screenshots/dark/B8-done.png) · [Visual measurements](visual/dark/B8-done.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B8-fail (dark)

[Snapshot](snapshots/dark/B8-fail.txt) · [Checker](checks/dark/B8-fail.txt) · [Screenshot](screenshots/dark/B8-fail.png) · [Visual measurements](visual/dark/B8-fail.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B8-unknown (dark)

[Snapshot](snapshots/dark/B8-unknown.txt) · [Checker](checks/dark/B8-unknown.txt) · [Screenshot](screenshots/dark/B8-unknown.png) · [Visual measurements](visual/dark/B8-unknown.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B18 (dark)

[Snapshot](snapshots/dark/B18.txt) · [Checker](checks/dark/B18.txt) · [Screenshot](screenshots/dark/B18.png) · [Visual measurements](visual/dark/B18.json)
- Gap: Owner memory-candidate proposals with save/discard actions are not implemented; the normal acknowledgement is shown without fabricating a proposal.

## B18-room-b (dark)

[Snapshot](snapshots/dark/B18-room-b.txt) · [Checker](checks/dark/B18-room-b.txt) · [Screenshot](screenshots/dark/B18-room-b.png) · [Visual measurements](visual/dark/B18-room-b.json)
- Gap: The monthly pricing table has no typed business-result producer; the memory-candidate row belongs to R-D. No table is inferred from worker text.
- Visual: region composer: [324,808,492,78] != [320,808,460,78] (2px tolerance)
- Visual: region main: [300,44,540,856] != [300,44,500,856] (2px tolerance)

## B22-room (dark)

[Snapshot](snapshots/dark/B22-room.txt) · [Checker](checks/dark/B22-room.txt) · [Screenshot](screenshots/dark/B22-room.png) · [Visual measurements](visual/dark/B22-room.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)

## B22-room-steps (dark)

[Snapshot](snapshots/dark/B22-room-steps.txt) · [Checker](checks/dark/B22-room-steps.txt) · [Screenshot](screenshots/dark/B22-room-steps.png) · [Visual measurements](visual/dark/B22-room-steps.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)

## B7 (light)

[Snapshot](snapshots/light/B7.txt) · [Checker](checks/light/B7.txt) · [Screenshot](screenshots/light/B7.png) · [Visual measurements](visual/light/B7.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B7-churn (light)

[Snapshot](snapshots/light/B7-churn.txt) · [Checker](checks/light/B7-churn.txt) · [Screenshot](screenshots/light/B7-churn.png) · [Visual measurements](visual/light/B7-churn.json)
- Gap: No browser/page-read telemetry is produced by these fixture text Works.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B7-done (light)

[Snapshot](snapshots/light/B7-done.txt) · [Checker](checks/light/B7-done.txt) · [Screenshot](screenshots/light/B7-done.png) · [Visual measurements](visual/light/B7-done.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B7-fail (light)

[Snapshot](snapshots/light/B7-fail.txt) · [Checker](checks/light/B7-fail.txt) · [Screenshot](screenshots/light/B7-fail.png) · [Visual measurements](visual/light/B7-fail.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B7-unknown (light)

[Snapshot](snapshots/light/B7-unknown.txt) · [Checker](checks/light/B7-unknown.txt) · [Screenshot](screenshots/light/B7-unknown.png) · [Visual measurements](visual/light/B7-unknown.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B8 (light)

[Snapshot](snapshots/light/B8.txt) · [Checker](checks/light/B8.txt) · [Screenshot](screenshots/light/B8.png) · [Visual measurements](visual/light/B8.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B8-done (light)

[Snapshot](snapshots/light/B8-done.txt) · [Checker](checks/light/B8-done.txt) · [Screenshot](screenshots/light/B8-done.png) · [Visual measurements](visual/light/B8-done.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B8-fail (light)

[Snapshot](snapshots/light/B8-fail.txt) · [Checker](checks/light/B8-fail.txt) · [Screenshot](screenshots/light/B8-fail.png) · [Visual measurements](visual/light/B8-fail.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B8-unknown (light)

[Snapshot](snapshots/light/B8-unknown.txt) · [Checker](checks/light/B8-unknown.txt) · [Screenshot](screenshots/light/B8-unknown.png) · [Visual measurements](visual/light/B8-unknown.json)
- Gap: These text-only Works have no named business procedure or browser/page-read telemetry.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.

## B18 (light)

[Snapshot](snapshots/light/B18.txt) · [Checker](checks/light/B18.txt) · [Screenshot](screenshots/light/B18.png) · [Visual measurements](visual/light/B18.json)
- Gap: Owner memory-candidate proposals with save/discard actions are not implemented; the normal acknowledgement is shown without fabricating a proposal.

## B18-room-b (light)

[Snapshot](snapshots/light/B18-room-b.txt) · [Checker](checks/light/B18-room-b.txt) · [Screenshot](screenshots/light/B18-room-b.png) · [Visual measurements](visual/light/B18-room-b.json)
- Gap: The monthly pricing table has no typed business-result producer; the memory-candidate row belongs to R-D. No table is inferred from worker text.
- Visual: region composer: [324,808,492,78] != [320,808,460,78] (2px tolerance)
- Visual: region main: [300,44,540,856] != [300,44,500,856] (2px tolerance)

## B22-room (light)

[Snapshot](snapshots/light/B22-room.txt) · [Checker](checks/light/B22-room.txt) · [Screenshot](screenshots/light/B22-room.png) · [Visual measurements](visual/light/B22-room.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)

## B22-room-steps (light)

[Snapshot](snapshots/light/B22-room-steps.txt) · [Checker](checks/light/B22-room-steps.txt) · [Screenshot](screenshots/light/B22-room-steps.png) · [Visual measurements](visual/light/B22-room-steps.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)
