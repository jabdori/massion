# Settings fidelity (E3d1)

32 Settings captures: required matches 588 → 856 / 982; contract diagnostics 394 → 126; visual diagnostics 32 → 0; infrastructure errors 0 → 0.

The complete CI command captured all 75 contracts in both system themes (150 unique runs), report-only exit 0 and no infrastructure errors. Contracts outside Settings retain their existing drift. This is fixture evidence, not real-provider, credential or device evidence.

[CI and unknown-save follow-up](ci-follow-up.md) · [Visual follow-up](visual-gate-follow-up.md) · [Actual store run](actual-store-final.txt) · [Before](before.json) · [Before-edit cause table](baseline-causes.md) · [After](after.json) · [All 150](full150.json) · [Exact residuals](remaining.md) · [Capability evidence](capabilities.md) · [Verification](verification.json) · [Independent review](review.md) · [Browser interactions](browser-interactions.json)

## Results and pairs

Artboard left, application right. Both themes were inspected. Ordering/occurrence rules and text budgets remain unchanged. Two B23 heading strings follow the owner-approved A2 count spacing; the original before baseline predates that spelling correction.

| State | Dark matches / failures | Light matches / failures | Dark pair | Light pair |
| --- | --- | --- | --- | --- |
| B13 | 17/22 · 5 | 17/22 · 5 | [PNG](pairs/dark/B13.png) | [PNG](pairs/light/B13.png) |
| B13-devices | 17/20 · 3 | 17/20 · 3 | [PNG](pairs/dark/B13-devices.png) | [PNG](pairs/light/B13-devices.png) |
| B13-general | 21/21 · 0 | 21/21 · 0 | [PNG](pairs/dark/B13-general.png) | [PNG](pairs/light/B13-general.png) |
| B13-general-restart | 21/23 · 2 | 21/23 · 2 | [PNG](pairs/dark/B13-general-restart.png) | [PNG](pairs/light/B13-general-restart.png) |
| B14 | 29/34 · 5 | 29/34 · 5 | [PNG](pairs/dark/B14.png) | [PNG](pairs/light/B14.png) |
| B14-expired | 29/34 · 5 | 29/34 · 5 | [PNG](pairs/dark/B14-expired.png) | [PNG](pairs/light/B14-expired.png) |
| B14-restart | 29/36 · 7 | 29/36 · 7 | [PNG](pairs/dark/B14-restart.png) | [PNG](pairs/light/B14-restart.png) |
| B14-update | 29/34 · 5 | 29/34 · 5 | [PNG](pairs/dark/B14-update.png) | [PNG](pairs/light/B14-update.png) |
| B14-usage | 30/34 · 4 | 30/34 · 4 | [PNG](pairs/dark/B14-usage.png) | [PNG](pairs/light/B14-usage.png) |
| B19 | 31/43 · 12 | 31/43 · 12 | [PNG](pairs/dark/B19.png) | [PNG](pairs/light/B19.png) |
| B19-juno | 31/37 · 6 | 31/37 · 6 | [PNG](pairs/dark/B19-juno.png) | [PNG](pairs/light/B19-juno.png) |
| B20 | 30/30 · 0 | 30/30 · 0 | [PNG](pairs/dark/B20.png) | [PNG](pairs/light/B20.png) |
| B20-coding | 29/29 · 0 | 29/29 · 0 | [PNG](pairs/dark/B20-coding.png) | [PNG](pairs/light/B20-coding.png) |
| B23 | 21/29 · 8 | 21/29 · 8 | [PNG](pairs/dark/B23.png) | [PNG](pairs/light/B23.png) |
| B23-github | 32/32 · 0 | 32/32 · 0 | [PNG](pairs/dark/B23-github.png) | [PNG](pairs/light/B23-github.png) |
| B23-github-expired | 32/33 · 1 | 32/33 · 1 | [PNG](pairs/dark/B23-github-expired.png) | [PNG](pairs/light/B23-github-expired.png) |

## Verification limits

The unchanged CI durable-store command ran against actual SurrealDB 3.3.0 in native Linux arm64 with Node 24.19.0: 1,935 tests, 1,902 passes, zero failures, 33 ordinary conditional browser skips (same skips as CI). The exact amd64 failing-file recheck passes all 13 cases against the CI-pinned amd64 archive. Typecheck, source/copy checks and 37 focused UI/token tests pass. The emulated amd64 full-suite process-argv limitation and preserved ownership guards are documented in ci-follow-up.md. Earlier macOS-only and timing attempts remain historical evidence. No backup/artifact implementation changed.

Two advisory longest-string warnings for recorded member metadata remain visible in after.json; hard text budgets are unchanged. Readonly or disabled controls are listed as capability residuals even when their accessible names satisfy a contract. No native restart, login/credential mutation, member memory/archive, app member binding, non-GitHub catalog or usage/budget outcome was manufactured. E3 as a whole remains open.
