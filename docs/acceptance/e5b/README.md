# E5b main integration and blocking visual-gate round

This candidate merges `origin/main` at `094eca4` into `feat/mcp-apps`, without rebasing or rewriting history. The server-options conflict preserves both daemon authentication and E5b's MCP/secret adapter ports. GitHub PR #111 was still open when checked; #112 and #113 are included in this main snapshot.

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
