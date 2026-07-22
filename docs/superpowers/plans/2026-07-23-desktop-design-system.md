# Massion Desktop Design System Implementation Plan

> **For agentic workers:** Use the approved `apps/desktop/DESIGN.md` as the visual source of truth. Keep each workstream independently reviewable; do not add a UI library or refactor unrelated product code.

**Goal:** Make the Massion desktop shell, Extensions, and Settings surfaces feel like one precise AgentOS product while removing the manual extension-install continuation step.

**Architecture:** Preserve the existing React/Tauri/DesktopService boundary and its durable Application events. Apply the fixed CSS tokens through the existing Base UI/shadcn source components. UI state stays local unless it represents durable domain state; extension installation continues to use the same command/correlation identity on automatic approval resumption.

**Tech Stack:** React 19, Tailwind CSS 4, existing Base UI/shadcn source components, Phosphor icons, cmdk, `react-resizable-panels`, Application API.

---

## Workstream 1: Shared operating shell

**Files:**
- Modify: `apps/desktop/src/app.tsx`
- Modify: `apps/desktop/src/components/ui/sidebar.tsx`
- Modify: `apps/desktop/src/styles.css`
- Test: `apps/desktop/src/app.test.tsx`

**Implementation:**

1. Replace the fixed global rail with the existing `Sidebar` composition: header (Massion + current organization), scrollable grouped navigation, footer (local connection and settings), and a controlled compact/expanded state.
2. Add one keyboard and pointer entry to toggle the sidebar. Do not persist this presentation preference or create a profile/settings record for it.
3. Use the tokens in `apps/desktop/DESIGN.md` to normalize the shared page header, list rows, selected state, dividers, focus ring, controls, empty states, and dialog depth. Reuse existing Button, Input, Tabs, ScrollArea, Tooltip, Command and Resizable source components; no daisyUI or new component package.
4. Rename every customer-visible `역량` label and accessibility name to `확장`.
5. Update the focused app test to cover sidebar collapse/expand and the renamed navigation entry. Do not run unrelated package suites.

**Acceptance:** Sidebar header/content/footer are visible in expanded mode, collapse preserves icon navigation with accessible labels, and all visible product surfaces inherit the same title/control/divider rhythm.

## Workstream 2: Extensions as one operating surface

**Files:**
- Modify: `apps/desktop/src/app.tsx`
- Modify: `apps/desktop/src/desktop-service.ts` only if the projection needs one typed field
- Test: `apps/desktop/src/app.integration.test.tsx`

**Implementation:**

1. On first entry, retain the existing parallel `extension.list` + `registry.inventory` load and render both results: `설치됨` first and `마켓플레이스` immediately below it. Do not make discovery depend on a search query.
2. Reuse one compact extension-row grammar for installed and catalog items. Give the selected item to the existing right inspector; installed rows must still not call `registry.info` with host activation identifiers.
3. Add one local search/filter view (`모두`, `설치됨`, `찾아보기`) and one deterministic sort. Search may call the current Registry search endpoint, but clearing it restores the loaded inventory rather than an empty list.
4. Replace all visible manual continuation controls with a quiet pending state. The approval itself remains in `결정`; after a successful approved vote, resume the stored install command automatically with the original `CommandIdentity` and `installApprovalId`, then refresh the capability projection. A rejected decision clears the pending visual state without an install retry.
5. Update only the extension integration tests: inventory appears without search, installed and marketplace records coexist, and approving the linked decision triggers exactly one resumption with the original identity. Delete assertions for the removed resume button.

**Acceptance:** The default Extensions screen shows installed state and marketplace inventory together; no customer-visible action says “승인 반영 후 설치 재개”; auto-resume cannot make a second install request for the same approval.

## Workstream 3: Provider-first Settings

**Files:**
- Modify: `apps/desktop/src/app.tsx`
- Test: `apps/desktop/src/app.integration.test.tsx`

**Implementation:**

1. Turn Settings into a persistent two-pane setting view: local section navigation on the left and the selected content on the right. Start at `모델 및 Provider`; keep account connections, execution policy, and local data as concise sections backed by existing reads only.
2. Make Provider connections and model routing readable as dense tables with clear empty states. Keep the existing provider registration, endpoint creation, credential submission, model registration, route configuration and candidate connection commands intact.
3. Keep secret input write-only: clear it after submit and never render credential values. Do not add local user-profile creation, login, or cloud-account requirements.
4. Use existing form primitives and labels above fields; move advanced route creation behind the local settings navigation instead of a single long form.
5. Update the focused settings integration test to verify the Provider section is the default, credential input remains password/write-only, and existing service commands are submitted unchanged.

**Acceptance:** A local user can configure a Provider and routing without a profile flow; the screen remains legible when no routes or accounts exist.

## Verification boundary

- Run the desktop typecheck once after merging the three workstreams.
- Run only the affected desktop integration tests and the automatic extension-resume test.
- Build the Vite frontend and inspect the three changed surfaces in the bundled desktop app. Do not re-run unrelated server, workspace, or historical migration suites unless the changed boundary requires them.
