# Durable exact Work budget history

The owner can read recorded budget changes after reconnect or through another headless client, instead of depending on one browser's recent observations. Basis: GOV-01, issue4 and [scope recorded before code](https://github.com/jabdori/massion/issues/4#issuecomment-6026863120), above PR28 `319ebac3c5741f66b9dea2dab6435753f3411b83`. Previous source and headless/headed/CI evidence are preserved.

## Read contract

`GET /missions/:id/work-budget-history?work=ID&after=0&limit=100` requires a currently known exact Mission/Work. It returns `missionId`, `workId`, `feedId`, frozen `through`, scanned `cursor`, `complete`, `scannedBatches` and `changes`. Each change contains only recorded numeric limit, literal reason, actor, commandId, revision and global cursor. It does not return other Mission/Work events, snapshots, memory or artifacts, infer prior limits, change units, or promise monetary caps.

For the next page, keep `through`, pass `cursor` as `after`, and send `X-Massion-Feed: <returned feedId>`. Continuation requires both original feed and boundary. Query fields are unique and limited to work/after/limit/through; numeric bounds are safe nonnegative integers, limit1–100. Each page scans at most that many existing global operation batches, so an empty filtered page may still advance the cursor and require another page. Stop only when `complete` is true. New writes beyond the frozen boundary appear only in a new initial read. Stale/replaced feed or beyond-head boundaries reject409; invalid bounds/missing continuation context reject400; unknown Mission/Work reject404. Even an empty/final page rechecks the database identity. Malformed matching recorded budget commands fail closed instead of becoming invented history.

The query uses existing `Store.readState`/`readCatchup`; no new journal schema/index, mutation, command admission, effect, retry/replay or provider dispatch. Initial and catch-up boundaries are checked against the same database feed. This is a bounded read over the existing unpruned journal, not an optimized indexed history service or retention fallback.

## Bounded evidence

Node24.19.0 / owned disposable SurrealDB3.3.0: affected history, owner budget, server and cursor recovery checks14/14, fail/skip0. Strict TypeScript, runtime syntax and whitespace passed. Initial supporting focused run2 passed/1 actual-DB conditional skip is a separate checkpoint. Actual HTTP/database history checks cover mixed Mission/Work commands, sparse limit1 pagination, a later concurrent write excluded from the original through boundary, exact reasons/identity, fresh HTTP host plus new actual-store adapter, original replay/stale rejected command with unchanged history, invalid/duplicate/unknown fields, unknown targets and stale/beyond-head feed requests. Snapshots and journal remain unchanged by every read/rejection, and no runtime/effect appears. A supporting in-memory injected changed feed between readState/catch-up proves final-page mismatch rejects; it is not a new actual process-replacement experiment. Existing affected cursor tests retain actual feed-fence coverage.

Independent read-only source/log review found no concrete finding and checked14/14 logs without rerunning tests/GUI/remote operations. Exact candidate, final review and automatic push/PR CI are recorded in the linked successor Draft PR/issue outcome. No manually repeated full DB aggregate or previous GUI check. Local raw evidence remains under `/home/jabtang/Documents/Codex/2026-10-05/task-11/work-budget-history/`; local paths are not hosted downloads.

## Remaining limits

The Work panel still labels recent reasons as incomplete browser observations; it does not invoke this new API yet. API projection alone is not browser, screen-reader/AT-SPI, full history presentation or general approval/policy certification. Authenticated multi-device ownership, retained-feed pruning, broader GOV-01 and live provider issue5 remain open. No live provider/account/credential/permission changes, new paid resources, correction experiment, merge or deployment.
