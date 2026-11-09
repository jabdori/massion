# E5b main integration and blocking visual-gate round

This candidate merges `origin/main` through `1d0d1e3` into `feat/mcp-apps`, without rebasing or rewriting history. It includes #111, #112 and #113. The first conflict preserves daemon authentication and MCP/secret adapter ports; the second preserves E5a cancellation on app network calls. MCP reuses E5a tool deadlines and secret slots; normal startup supplies the keychain adapter. All commits in this round are pushed together.

## Result

- Typecheck: passed ([output](typecheck.txt)).
- Related tests: **224 passed, 3 skipped, 0 failed**, across 18 files ([output](related-tests.txt)). A final source-time boundary regression and rerun of both conversation suites passed **57 tests, 2 skipped, 0 failed** ([output](source-time-tests.txt)). Skips require opt-in real SurrealDB.
- Headless screen checks: **542/542 required elements across 22 screen/theme runs**, **0 contract failures**, **0 measured visual failures**, **0 infrastructure errors**. Twenty advisory text-budget warnings remain. These counts are not pixel equality or a claim that every pictured data producer exists.
- Actual fixture clicks through Later → Ask again → masked token entry → one submission → connected state passed in dark and light. The iframe probe also passed parent-DOM/network denial and the closed layout message API ([action report](actions/report.json)).
- All screenshots, side-by-side pairs, snapshots, measurements and action evidence are committed here. The prototype is on the left of each pair; the actual renderer is on the right.

The blocking notice/reply ordering defect is fixed using recorded host message times, with explicit legacy-journal compatibility. The missing app-driven Work row, PR table and total/full-result target remain **data-driven residuals** with concrete code evidence in [the residual ledger](residual-ledger.md). No fabricated Work, hidden app invocation, hard-coded PR total or relaxed contract was added. Historical messages without recorded times retain their previous ordering rather than receiving guessed timestamps.

## Review pairs

| State | Dark | Light |
| --- | --- | --- |
| B24-done | [pair](pairs/dark/B24-done.png) | [pair](pairs/light/B24-done.png) |
| B24-later | [pair](pairs/dark/B24-later.png) | [pair](pairs/light/B24-later.png) |
| B25-done | [pair](pairs/dark/B25-done.png) | [pair](pairs/light/B25-done.png) |
| B25-later | [pair](pairs/dark/B25-later.png) | [pair](pairs/light/B25-later.png) |
| Token entry | [pair](pairs/dark/B24-connect-token.png) | [pair](pairs/light/B24-connect-token.png) |

[All 22 runs](report.md) · [machine-readable report](report.json). The standard read-only fixture host retains four transition-gap annotations; the separate action overlay covers those clicks without changing production APIs or invoking accounts.

## Reproduction

```sh
npm run typecheck
TMPDIR=/private/tmp node --test tests/apps.test.ts tests/mcp-apps.test.ts tests/app-connect-surface.test.ts tests/app-frame.test.ts tests/apps-surface.test.ts tests/server.test.ts tests/protocol.test.ts tests/client-protocol.test.ts tests/protocol-workbench.test.ts tests/internal-teams.test.ts tests/internal-teams-surface.test.ts tests/assistant-conversation.test.ts tests/assistant-conversation-storage.test.ts tests/conversation-cards.test.ts tests/ui-contract-fixtures.test.ts tests/ui-copy.test.ts desktop/tests/auth.test.ts desktop/tests/bridge.test.ts
UI_CONTRACTS_OUTPUT=docs/acceptance/e5b node scripts/ui-contracts/run.mjs B24 B24-done B24-later B25 B25-done B25-later B24-connect B24-connect-token B24-connect-connected B24-connect-later B24-connect-mail
node docs/acceptance/e5b-ui/verify.mjs
```

The recorded test run used the physical scratchpad TMPDIR prescribed by CODEX-BRIEF. Generated browser configuration/clock files are not committed. Full-suite CI, live accounts, OS keychain, native MCP launching and the independent review are not replaced by these fixture checks.


## Final E5a integration checks

After #111 merged, the focused MCP/apps/shared-timeout/slots/runtime/server/daemon-auth checks passed **55 tests, one real-DB skip, zero failures** ([output](e5a-integration-tests.txt)); typecheck passed again. The secret sentinel test now exercises E5a's real `InMemorySecretSlots` API. MCP's duplicate timer implementation was removed. The personal keychain was not mutated and no concrete native MCP transport was invoked. This merge changed no rendered client, fixture or CSS bytes, so the committed visual captures remain the renderer tested in this round.

The final post-#111 conversation/source-lineage, member Work and internal-team rerun passed **124 tests, 2 real-DB skips, zero failures** ([output](post111-conversation-tests.txt)).

## Independent-review and CI follow-up

The owner-reconciliation fix and its actual host/browser evidence are documented in [reconciliation.md](reconciliation.md). The unknown-write block remains until an evidenced owner command settles that exact call; no reconciliation resends it. This round also corrects the desktop bundle insertion and the offline draft initialization order exposed by CI.


Final integration includes main `395193e` (#115/#116) without rebasing. Auto-merge preserved the reconciliation and startup fixes. Post-integration typecheck and related suites passed **239 tests, 4 opt-in skips, zero failures** ([log](desktop-ci/main395-tests.txt)); the actual reconciliation browser flow and rebuilt Linux Xvfb smoke passed again ([smoke](desktop-ci/main395-smoke.txt)). Only affected checks were run locally; the full suite remains CI work.
