# UI contracts

Mode: **REPORT-ONLY**. 0/20 screen/theme runs pass all measured checks; 20 have drift, gaps or errors.

Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.

| Screen | Theme | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B4 | dark | 30 / 35 | 5 | 0 | 0 | 0 | 0 | [PNG](pairs/dark/B4.png) |
| B7 | dark | 39 / 40 | 1 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B7.png) |
| B7-churn | dark | 41 / 74 | 33 | 2 | 0 | 4 | 0 | [PNG](pairs/dark/B7-churn.png) |
| B7-done | dark | 35 / 47 | 12 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B7-done.png) |
| B7-fail | dark | 39 / 78 | 39 | 2 | 0 | 4 | 0 | [PNG](pairs/dark/B7-fail.png) |
| B7-unknown | dark | 36 / 46 | 10 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B7-unknown.png) |
| B8 | dark | 23 / 31 | 8 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B8.png) |
| B8-done | dark | 24 / 36 | 12 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B8-done.png) |
| B8-fail | dark | 26 / 36 | 10 | 3 | 0 | 4 | 0 | [PNG](pairs/dark/B8-fail.png) |
| B8-unknown | dark | 23 / 36 | 13 | 2 | 0 | 3 | 0 | [PNG](pairs/dark/B8-unknown.png) |
| B4 | light | 30 / 35 | 5 | 0 | 0 | 0 | 0 | [PNG](pairs/light/B4.png) |
| B7 | light | 39 / 40 | 1 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B7.png) |
| B7-churn | light | 41 / 74 | 33 | 2 | 0 | 4 | 0 | [PNG](pairs/light/B7-churn.png) |
| B7-done | light | 35 / 47 | 12 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B7-done.png) |
| B7-fail | light | 39 / 78 | 39 | 2 | 0 | 4 | 0 | [PNG](pairs/light/B7-fail.png) |
| B7-unknown | light | 36 / 46 | 10 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B7-unknown.png) |
| B8 | light | 23 / 31 | 8 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B8.png) |
| B8-done | light | 24 / 36 | 12 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B8-done.png) |
| B8-fail | light | 26 / 36 | 10 | 3 | 0 | 4 | 0 | [PNG](pairs/light/B8-fail.png) |
| B8-unknown | light | 23 / 36 | 13 | 2 | 0 | 3 | 0 | [PNG](pairs/light/B8-unknown.png) |

## B4 (dark)

[Snapshot](snapshots/dark/B4.txt) · [Checker](checks/dark/B4.txt) · [Screenshot](screenshots/dark/B4.png) · [Visual measurements](visual/dark/B4.json)

## B7 (dark)

[Snapshot](snapshots/dark/B7.txt) · [Checker](checks/dark/B7.txt) · [Screenshot](screenshots/dark/B7.png) · [Visual measurements](visual/dark/B7.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B7-churn (dark)

[Snapshot](snapshots/dark/B7-churn.txt) · [Checker](checks/dark/B7-churn.txt) · [Screenshot](screenshots/dark/B7-churn.png) · [Visual measurements](visual/dark/B7-churn.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B7-done (dark)

[Snapshot](snapshots/dark/B7-done.txt) · [Checker](checks/dark/B7-done.txt) · [Screenshot](screenshots/dark/B7-done.png) · [Visual measurements](visual/dark/B7-done.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B7-fail (dark)

[Snapshot](snapshots/dark/B7-fail.txt) · [Checker](checks/dark/B7-fail.txt) · [Screenshot](screenshots/dark/B7-fail.png) · [Visual measurements](visual/dark/B7-fail.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B7-unknown (dark)

[Snapshot](snapshots/dark/B7-unknown.txt) · [Checker](checks/dark/B7-unknown.txt) · [Screenshot](screenshots/dark/B7-unknown.png) · [Visual measurements](visual/dark/B7-unknown.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B8 (dark)

[Snapshot](snapshots/dark/B8.txt) · [Checker](checks/dark/B8.txt) · [Screenshot](screenshots/dark/B8.png) · [Visual measurements](visual/dark/B8.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

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

## B8-unknown (dark)

[Snapshot](snapshots/dark/B8-unknown.txt) · [Checker](checks/dark/B8-unknown.txt) · [Screenshot](screenshots/dark/B8-unknown.png) · [Visual measurements](visual/dark/B8-unknown.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B4 (light)

[Snapshot](snapshots/light/B4.txt) · [Checker](checks/light/B4.txt) · [Screenshot](screenshots/light/B4.png) · [Visual measurements](visual/light/B4.json)

## B7 (light)

[Snapshot](snapshots/light/B7.txt) · [Checker](checks/light/B7.txt) · [Screenshot](screenshots/light/B7.png) · [Visual measurements](visual/light/B7.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B7-churn (light)

[Snapshot](snapshots/light/B7-churn.txt) · [Checker](checks/light/B7-churn.txt) · [Screenshot](screenshots/light/B7-churn.png) · [Visual measurements](visual/light/B7-churn.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B7-done (light)

[Snapshot](snapshots/light/B7-done.txt) · [Checker](checks/light/B7-done.txt) · [Screenshot](screenshots/light/B7-done.png) · [Visual measurements](visual/light/B7-done.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B7-fail (light)

[Snapshot](snapshots/light/B7-fail.txt) · [Checker](checks/light/B7-fail.txt) · [Screenshot](screenshots/light/B7-fail.png) · [Visual measurements](visual/light/B7-fail.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
- Gap: Confirmed enterprise steering followed by continued active/settled churn has no producing continuation path: domain steer sets waiting and settle-task rejects waiting; plain member exchanges and all three Copy controls are supported.

## B7-unknown (light)

[Snapshot](snapshots/light/B7-unknown.txt) · [Checker](checks/light/B7-unknown.txt) · [Screenshot](screenshots/light/B7-unknown.png) · [Visual measurements](visual/light/B7-unknown.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

## B8 (light)

[Snapshot](snapshots/light/B8.txt) · [Checker](checks/light/B8.txt) · [Screenshot](screenshots/light/B8.png) · [Visual measurements](visual/light/B8.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.

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

## B8-unknown (light)

[Snapshot](snapshots/light/B8-unknown.txt) · [Checker](checks/light/B8-unknown.txt) · [Screenshot](screenshots/light/B8-unknown.png) · [Visual measurements](visual/light/B8-unknown.json)
- Gap: No host producer supplies named business steps, per-step timestamps or browser/page-read telemetry; only the root/executor/verifier task statuses and results are retained.
- Gap: No host producer supplies payment approval, payment amounts, order history, vendor receipts or subscription-CLI connection proof for these text-only Works.
- Gap: AssistantSource and pinned criteria have no handoff or criteria-fix timestamp; member replies remain separate from owner-only Work discussion.
