# UI contracts

Mode: **REPORT-ONLY**. 0/12 screen/theme runs pass all measured checks; 12 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B7-churn | dark | 44 / 74 | 30 | 2 | 0 | 4 | 0 | [PNG](pairs/dark/B7-churn.png) |
| B8-done | dark | 24 / 36 | 12 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B8-done.png) |
| B8-fail | dark | 26 / 36 | 10 | 3 | 0 | 4 | 0 | [PNG](pairs/dark/B8-fail.png) |
| B15 | dark | 19 / 35 | 16 | 0 | 2 | 1 | 0 | [PNG](pairs/dark/B15.png) |
| B22-room | dark | 34 / 40 | 6 | 0 | 1 | 0 | 0 | [PNG](pairs/dark/B22-room.png) |
| B22-room-steps | dark | 42 / 49 | 7 | 0 | 1 | 0 | 0 | [PNG](pairs/dark/B22-room-steps.png) |
| B7-churn | light | 44 / 74 | 30 | 2 | 0 | 4 | 0 | [PNG](pairs/light/B7-churn.png) |
| B8-done | light | 24 / 36 | 12 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B8-done.png) |
| B8-fail | light | 26 / 36 | 10 | 3 | 0 | 4 | 0 | [PNG](pairs/light/B8-fail.png) |
| B15 | light | 19 / 35 | 16 | 0 | 2 | 1 | 0 | [PNG](pairs/light/B15.png) |
| B22-room | light | 34 / 40 | 6 | 0 | 1 | 0 | 0 | [PNG](pairs/light/B22-room.png) |
| B22-room-steps | light | 42 / 49 | 7 | 0 | 1 | 0 | 0 | [PNG](pairs/light/B22-room-steps.png) |

## B7-churn (dark)

[Snapshot](snapshots/dark/B7-churn.txt) · [Checker](checks/dark/B7-churn.txt) · [Screenshot](screenshots/dark/B7-churn.png) · [Visual measurements](visual/dark/B7-churn.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B8-done (dark)

[Snapshot](snapshots/dark/B8-done.txt) · [Checker](checks/dark/B8-done.txt) · [Screenshot](screenshots/dark/B8-done.png) · [Visual measurements](visual/dark/B8-done.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B8-fail (dark)

[Snapshot](snapshots/dark/B8-fail.txt) · [Checker](checks/dark/B8-fail.txt) · [Screenshot](screenshots/dark/B8-fail.png) · [Visual measurements](visual/dark/B8-fail.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B15 (dark)

[Snapshot](snapshots/dark/B15.txt) · [Checker](checks/dark/B15.txt) · [Screenshot](screenshots/dark/B15.png) · [Visual measurements](visual/dark/B15.json)
- Gap: The production workbench has no browser tab, address bar, or embedded library form; only its submission decision can render.
- Visual: region composer: [530,808,680,78] != [324,808,492,78] (2px tolerance)
- Visual: region main: [300,44,1140,856] != [300,44,540,856] (2px tolerance)

## B22-room (dark)

[Snapshot](snapshots/dark/B22-room.txt) · [Checker](checks/dark/B22-room.txt) · [Screenshot](screenshots/dark/B22-room.png) · [Visual measurements](visual/dark/B22-room.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)

## B22-room-steps (dark)

[Snapshot](snapshots/dark/B22-room-steps.txt) · [Checker](checks/dark/B22-room-steps.txt) · [Screenshot](screenshots/dark/B22-room-steps.png) · [Visual measurements](visual/dark/B22-room-steps.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)

## B7-churn (light)

[Snapshot](snapshots/light/B7-churn.txt) · [Checker](checks/light/B7-churn.txt) · [Screenshot](screenshots/light/B7-churn.png) · [Visual measurements](visual/light/B7-churn.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B8-done (light)

[Snapshot](snapshots/light/B8-done.txt) · [Checker](checks/light/B8-done.txt) · [Screenshot](screenshots/light/B8-done.png) · [Visual measurements](visual/light/B8-done.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B8-fail (light)

[Snapshot](snapshots/light/B8-fail.txt) · [Checker](checks/light/B8-fail.txt) · [Screenshot](screenshots/light/B8-fail.png) · [Visual measurements](visual/light/B8-fail.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B15 (light)

[Snapshot](snapshots/light/B15.txt) · [Checker](checks/light/B15.txt) · [Screenshot](screenshots/light/B15.png) · [Visual measurements](visual/light/B15.json)
- Gap: The production workbench has no browser tab, address bar, or embedded library form; only its submission decision can render.
- Visual: region composer: [530,808,680,78] != [324,808,492,78] (2px tolerance)
- Visual: region main: [300,44,1140,856] != [300,44,540,856] (2px tolerance)

## B22-room (light)

[Snapshot](snapshots/light/B22-room.txt) · [Checker](checks/light/B22-room.txt) · [Screenshot](screenshots/light/B22-room.png) · [Visual measurements](visual/light/B22-room.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)

## B22-room-steps (light)

[Snapshot](snapshots/light/B22-room-steps.txt) · [Checker](checks/light/B22-room-steps.txt) · [Screenshot](screenshots/light/B22-room-steps.png) · [Visual measurements](visual/light/B22-room-steps.json)
- Visual: region composer: [324,808,492,78] != [320,808,500,78] (2px tolerance)
