# Settings > Apps: causes and evidence

Scope: `src/apps-panel.ts` Settings renderers and Settings-only CSS, `tests/apps-surface.test.ts`, and `scripts/ui-contracts/fixtures/B23*.json`. The shared Settings navigation, geometry and shell fixture corrections belong to the main worker. No API, catalog expansion, app page, rail, pane or conversation command changes.

## Baseline classification before implementation

Classification was recorded only after `.runtime/e3d1-before/checks/light/B23-github-expired.txt` existed. Both themes have 12 B23, 2 B23-github and 3 B23-github-expired failures (34 total).

| Screen | Theme | Baseline diagnostic | Cause and evidence |
|---|---|---|---|
| B23 | dark | `FAIL  missing sidebar      textbox  "설정 검색"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23 | dark | `FAIL  missing sidebar      link     "사용량"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23 | dark | `FAIL  missing settings     textbox  "앱 검색"` | UI: `settingsAppsView` has no search. Filter its loaded rows locally using approved `settings.textbox.01`; no async read or command needed. |
| B23 | dark | `FAIL  missing settings     link     "{work_title} 1.4.0 · 주노, 퀼 켜짐"` | Capability: `AppsService.read()` returns app manifest contributions, not member assignments. No installed-app user list is produced; do not infer users from all conversation members. |
| B23 | dark | `FAIL  missing settings     heading  "직접 만든 앱1"` | Fixture: B23 omits a supported installed self-made app. `AppsService.offerSelfMade`, `decide` and `read` produce this shape with maker, accepted source Work and check. |
| B23 | dark | `FAIL  missing settings     heading  "추천"` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | dark | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | dark | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | dark | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | dark | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | dark | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | dark | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23-github | dark | `FAIL  missing sidebar      textbox  "설정 검색"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23-github | dark | `FAIL  missing sidebar      link     "사용량"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23-github-expired | dark | `FAIL  missing sidebar      textbox  "설정 검색"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23-github-expired | dark | `FAIL  missing sidebar      link     "사용량"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23-github-expired | dark | `FAIL  missing settings     button   "다시 연결"` | Capability: `AppsService.read()` exposes only declared secret slot/label, no expiry or credential state; `act()` accepts install/disable/enable/remove/rollback only. No app reconnect producer or command exists. |
| B23 | light | `FAIL  missing sidebar      textbox  "설정 검색"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23 | light | `FAIL  missing sidebar      link     "사용량"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23 | light | `FAIL  missing settings     textbox  "앱 검색"` | UI: `settingsAppsView` has no search. Filter its loaded rows locally using approved `settings.textbox.01`; no async read or command needed. |
| B23 | light | `FAIL  missing settings     link     "{work_title} 1.4.0 · 주노, 퀼 켜짐"` | Capability: `AppsService.read()` returns app manifest contributions, not member assignments. No installed-app user list is produced; do not infer users from all conversation members. |
| B23 | light | `FAIL  missing settings     heading  "직접 만든 앱1"` | Fixture: B23 omits a supported installed self-made app. `AppsService.offerSelfMade`, `decide` and `read` produce this shape with maker, accepted source Work and check. |
| B23 | light | `FAIL  missing settings     heading  "추천"` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | light | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | light | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | light | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | light | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | light | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23 | light | `FAIL  role   settings     link     "설치" (text exists without the required role)` | Capability: `src/app-catalog.ts:CATALOG` contains only GitHub, already installed here. `AppsService.act()` rejects unknown catalog IDs. The six other artboard recommendations and their install controls cannot be produced. |
| B23-github | light | `FAIL  missing sidebar      textbox  "설정 검색"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23-github | light | `FAIL  missing sidebar      link     "사용량"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23-github-expired | light | `FAIL  missing sidebar      textbox  "설정 검색"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23-github-expired | light | `FAIL  missing sidebar      link     "사용량"` | Shared UI: Settings search and Usage navigation are absent from `src/settings-panel.ts:settingsSide`; main worker owns correction. |
| B23-github-expired | light | `FAIL  missing settings     button   "다시 연결"` | Capability: `AppsService.read()` exposes only declared secret slot/label, no expiry or credential state; `act()` accepts install/disable/enable/remove/rollback only. No app reconnect producer or command exists. |

Both themes also report the shared main rectangle `[300,44,1140,856]` instead of `[300,0,1140,900]`; the main worker owns the Settings band/geometry correction. No text-budget failure or checker defect is demonstrated by these baseline reports.

## Artboard review beyond checker matches

Original source: `/private/tmp/claude-501/-Users-code-massion/dc2d9a0d-e0f8-420f-84fc-beec74d770c3/scratchpad/proto/render/B23*.dc.html`; approved images: `docs/product/screens/artboards/{dark,light}/B23*.png`. Baseline detail screenshot has 56px rows, a 120px label column and oversized header controls; the approved HTML uses compact rows (`11px 16px`), a 76px label column, 28px controls and a branch mark. Correct these with existing generated tokens and Settings-only selectors.

The original `gives` array contains `PR 목록 · PR 탭`, not a `{title} 목록 ›` page link. The host supplies only `contributes.page.title` and `roomTab.prefix`: render the actual page title and the existing `settings.link.06` Open action; do not label every arbitrary page as a list. Member names beside skills/procedures/tools are unavailable: manifest contributions are string arrays, and no per-member installation or binding is returned by `AppsService.read()`.

Artboard token states (`Saved`, `Expired`) and write/file/event examples are not host facts. Preserve actual declared permissions and token labels only. Do not add a password field or fabricate stored credentials. Self-made source titles and IDs are produced by `AppsService.read()`. Although the older architecture note lists this link as deferred, the existing `paneOpen` / `paneSelect` navigation accepts those IDs. Reuse that path from a separate source button, without nesting interactive controls or adding a command.

## Verification

RED was observed before UI changes with `node --test tests/apps-surface.test.ts`: 11 passed, 2 failed (app search absent; an arbitrary host page titled Release notes was incorrectly called a list). The added source-link assertion separately failed before source navigation was implemented. Strengthening it to require the actual Work card then failed against the empty Mission fixture, demonstrating the remaining fixture gap.

GREEN: `node --test tests/apps-surface.test.ts tests/surface-shell.test.ts` passed 46/46, including all 14 Apps tests. `node --test --test-name-pattern='started Work snapshots' tests/ui-contract-fixtures.test.ts` passed 1/1. The B23 source fixture reuses B25-done's existing accepted PR #84 Mission, matching Work summary and read-only artifact response; it preserves the accepted Record checksum rather than inventing one. Its app ID is `appIdOf('self-made', 'member-juno', 'pr-list-fetcher')`.

The complete fixture test file initially passed 12/12 before the source fixture extension. A later combined run exposed B23's missing matching Work summary (corrected and the invariant test rerun GREEN), plus the main worker's concurrent B20 editor-gap assertion; the latter was reported to the main worker without editing their files.

The tests exercise case-insensitive/trimmed local search across installed, self-made and available catalog rows, retained input focus, zero search requests, real page Open navigation, source Work loading, absence of nested buttons, and secret-value sentinels absent from rendered text, requests and storage. Overlapping install/disable/rollback actions admit one request with a command ID; a lost response never resends. Existing Settings read-generation and app-view feed/out-of-order tests remain GREEN. Source navigation delegates to `paneOpen` and `paneSelect`, which reuse `loadMission`'s `mission-view` scope and read sequence; no new async reader or command API was added.

`npm run typecheck`, `node scripts/check.mjs` (zero copy findings), and `git diff --check` were run. The main worker owns the final aggregate check and all final captures.

One scoped headless run completed before the main worker requested sole capture ownership: `UI_CONTRACTS_OUTPUT=.runtime/e3d1-apps-after node scripts/ui-contracts/run.mjs B23 B23-github B23-github-expired`. The six rows contain 18 residual diagnostics in total (34 before), zero visual-contract failures, zero infrastructure errors. Its screenshots were inspected in dark/light; the run preceded the final accepted-source fixture repair and is intermediate evidence, not the final shared candidate. No further browser runner was launched after the capture handoff.

| Screen | Dark required matches / failures | Light required matches / failures |
|---|---|---|
| B23 | 21/29; 8 failures | 21/29; 8 failures |
| B23-github | 32/32; 0 failures | 32/32; 0 failures |
| B23-github-expired | 32/33; 1 failure | 32/33; 1 failure |

## Exact remaining capability diagnostics

Each theme has the same residuals:

- B23: one missing installed-app link with the fixed member suffix `주노, 퀼` (the host returns no installed-app member bindings); one missing Recommended heading; six Install role diagnostics. GitHub is already installed, and the bundled catalog has no Slack, Linear, Google Calendar, Notion, Figma or Sentry package. Evidence: `src/apps.ts:146-152` returns no catalog-app member list; `src/app-catalog.ts:13-16` exports GitHub only; `src/apps.ts:204-206` accepts only known catalog IDs.
- B23-github: no remaining contract diagnostic. The artboard's member bindings beside contributed skills/procedures/tools and stored-token status still have no producing host facts, even though the generic placeholder matcher accepts other text. Evidence: `src/apps.ts:149` clones manifest contribution string arrays and secret declarations only; `docs/architecture/apps.md`, Not in this increment, explicitly excludes installing those contributions into members and setting secret values.
- B23-github-expired: one missing Reconnect button. Evidence: `src/apps.ts:149` exposes no expiry or credential-configured field; `src/apps.ts:204-207` supports install, disable, enable, remove and rollback only. No app token save/reconnect command exists.

Declared permission differences remain real host data: the bundled package is read-only, declares no file access, names its token slot without storage status, and declares PR opened/merged events. The UI does not substitute the artboard's write/file permissions, token success, or different events. No unimplemented catalog package, owner/member binding, stored credential, token expiry or reconnect outcome was fabricated.
