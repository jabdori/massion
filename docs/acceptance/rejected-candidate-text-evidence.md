# Rejected candidate inspection evidence

Base: Draft #51 `dac58e809c46efad3ef2268b94df9437cbba7aef`. Separate no-hardlinks checkout `massion-rejected-text`; original PR49 UI candidate and all prior clones/uncommitted work/failure logs retained. Remote PR49/PR51 exact heads rechecked before publication. No reset, deletion, merge, deployment, real model calls, new paid resources or account rights changes.

2026-10-07 final source validation: Node 24.21.0, TypeScript 7.0.2, SurrealDB 3.3.0 owned disposable store, isolated headless Chrome 151.0.7922.34. Static types and runtime syntax passed. Affected actual-store gate **39/39 passed, zero skips**: rejected API/UI/normal CLI browser plus existing accepted Record query/panel. Full command and raw counts are preserved outside the checkout in `rejected-final-affected-2.log`; `rejected-typecheck-final.log`, `rejected-check-final.log`, and `rejected-browser-final.png` retain supporting evidence.

```sh
npm run typecheck
node scripts/check.mjs
# With configured owned SurrealDB binary, Playwright module/browser path and workspace TMPDIR:
python3 scripts/with-surreal.py --timeout 180 -- node --test --test-concurrency=1 \
  tests/rejected-text.test.ts tests/rejected-text-panel.test.ts \
  tests/rejected-text-cli-browser.test.ts tests/owner-record-artifact.test.ts \
  tests/owner-record-artifact-panel.test.ts
```

Normal CLI starts existing `src/server.ts --host-config` with an owned credential-free loopback fixture. Keyboard selects/reviews/starts one existing fresh Work through the existing sequence panel, obtains failed independent Assurance, reads exact literal hostile Unicode bytes and original failed verdict, cancels a held read and reinspects deliberately. Viewports 390/1280 have no horizontal overflow. Reload reads nothing automatically; SIGTERM/restart leaves **grants0, automatic calls0, fixture calls2, live calls0**, failed Work/old Work/Record/journal unchanged. The failed candidate never obtains an accepted Record. Screenshot visually inspected.

API/UI tests reject unknown effects, original input/criteria/verdict substitution, cancelled Work (while retaining artifact/verdict), feed change during asynchronous read, tampered artifact, injected query paths/duplicates, wrong reply classification and bytes. Late Mission replies and ignored-abort held responses cannot restore text. Read sends no POST and preserves owner draft/journal; unrelated writes do not substitute selected evidence. Existing accepted Record query, response-loss markers, portable restore and CLI restart remain regression checks.

Independent read-only review found two P2s: missing settled execution guard after normal cancel, and keyboard Cancel focus. Both fixed and regression-tested; final rereview of guard/focus/direct AbortSignal fetch found no additional blocker. Initial dynamic test lookup failures, hidden-element wait failure, interrupted held-read fixture, type diagnostic and Chrome renderer crash logs remain preserved; they are not counted as passed. Final gate uses sufficient workspace TMPDIR and disables Chrome shared-memory use; no other user's temporary files were removed.

Exact publication head and both push/PR CI run IDs/counts are recorded in the Draft PR and external `rejected-final-evidence.json` after CI concludes. Optional Chrome tests are conditionally skipped in CI without a configured Playwright path; local actual DB + Chrome execution above is separate evidence. Full issue #4 remains open: another correction attempt/admission, real model semantic judgment/usefulness, authenticated remote providers/identities, broad platform/accessibility and general scheduling/recovery are not established by this bounded query/UI increment.
