# Fresh owner correction Work evidence

Base Draft #52: `732c84b40d47fdecdc2a1269628de4d0068fea6c`. Separate no-hardlinks `massion-correction-ui` checkout. Original task11/provider-only/task4, PR49 UI uncommitted candidate, PR50/51/52 clones and all prior failed evidence retained. No reset or source deletion, merge/deploy, real model call, paid resource or account authority change.

2026-10-07 final implementation gate: Node24.21.0/TypeScript7.0.2, owned disposable SurrealDB3.3.0, isolated headless Chrome151.0.7922.34 with workspace TMPDIR. Static types, runtime syntax and whitespace pass. **Affected actual DB+normal CLI+Chrome gate80/80 pass, fail0, skip0**, preserved raw `correction-final-affected.log`; current `correction-types-last.log`, `correction-syntax-last.log`, `correction-browser-final.png` retained outside checkout. No historical passes are added to these counts.

```sh
npm run typecheck
node scripts/check.mjs
# Configured owned binary, Playwright module/browser path and workspace TMPDIR:
python3 scripts/with-surreal.py --timeout 240 -- node --test --test-concurrency=1 \
 tests/owner-correction.test.ts tests/owner-correction-panel.test.ts \
 tests/owner-correction-cli-browser.test.ts tests/rejected-text.test.ts \
 tests/rejected-text-panel.test.ts tests/owner-prerequisite-panel.test.ts \
 tests/owner-run-sequence-panel.test.ts
```

Normal `src/server.ts --host-config` runs only owned credential-free loopback executor/verifier fixtures. Chrome keyboard explicitly starts incorrect existing fresh Work, privately reviews/cancels a correction draft, then reviews/admit distinct new Work (additional provider calls0). Separate sequence review/start invokes fixed executor/verifier, creates a new accepted Record with exact original correction provenance and @6 input contract, retaining all old Work/failed artifact/verdict/claims/receipt/Record. Viewports390/1280 do not overflow; final screenshot visually inspected. Reload and SIGTERM/restart leave grants0/automatic calls0, fixture calls4/live calls0 and exact final snapshot/journal unchanged. Existing PR50/51 Chrome gates also ran in this affected gate; optional CI skips are separate.

Supporting actual DB/API/UI checks cover new admission/replay with no duplicate, stale/hash/feed/forged/null/extra authority rejection, changed revision requiring review, unknown/interrupted/cancelled/accepted original, actual persisted unknown effect with unchanged reservations/claims/receipt and no new admission/replay, caller envelope mutation during an awaited lookup, committed response loss and exact receipt readback, late edits/moved focus/Mission changes for successful/rejected/unknown replies, source/provenance/provider prompt/Record/hash and inert journal lineage. Original correction decision is historical provenance, not automatic inheritance of source/prerequisites nor a requirement for original rejection to pass. New Work uses current Mission admission inputs and requires explicit source/prerequisite selection if desired.

Independent read-only source review reported no blocker; receipt wording P2 changed to historical 'admission did not start execution'. Correction input extension version @6 was added and asserted; rereview confirmed no remaining blocker. Reviewer test attempt hit sandbox loopback listen EPERM, so independent execution is not claimed; authorized parent actual DB/CLI/Chrome gate above supplies execution proof. Initial nullable-selection type diagnostic is preserved in `correction-types-2.log` and fixed; it is not counted as a passed check.

Exact head and push/PR CI IDs/counts are recorded in Draft description and external `correction-final-evidence.json` after CI completes. This closes the bounded fresh correction admission path, not real model correctness/usefulness, remote authentication/identity, unknown recovery/reconciliation, scheduler/reclaim, broad accessibility/platform or full issue4 acceptance. No automatic continuation, authority restoration, merge or deployment.
