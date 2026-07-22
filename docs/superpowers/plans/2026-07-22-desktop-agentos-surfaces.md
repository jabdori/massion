# Desktop AgentOS Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 독립 Massion 데스크톱에 7개 운영 표면, Provider 설정, 실제 Extension Registry 설치 경로를 구현합니다.

**Architecture:** 현재 Application API와 Desktop bridge를 유지합니다. 먼저 Extension/Registry를 서버 composition root에 연결하고, 이어서 shadcn Base UI 공통 셸과 Desktop service 투영을 구현합니다. Provider 설정은 이미 생산 조립된 router/subscription 계약을 소비하며, Extension은 같은 lifecycle을 통한 Registry 설치만 노출합니다.

**Tech Stack:** React 19, Vite, Tailwind CSS 4, shadcn/ui Base UI, Tauri bridge, TypeScript, Vitest, SurrealDB, VoltAgent.

---

## 파일 책임 맵

| 파일 | 변경 책임 |
|---|---|
| `apps/server/src/product.ts` | Extension Host·Registry adapter를 daemon/Application Product에 한 번만 조립 |
| `apps/server/src/product.test.ts` | 실제 daemon에서 Extension query/Registry operation이 등록되는지 검증 |
| `apps/desktop/components.json` | 최신 Base UI shadcn CLI가 검증하는 구성 |
| `apps/desktop/package.json` / `pnpm-lock.yaml` | shadcn source가 요구하는 최소 런타임 의존성 |
| `apps/desktop/src/components/ui/*` | 직접 소유하는 필요한 shadcn primitive source |
| `apps/desktop/src/styles.css` | 기존 제품 토큰을 shadcn semantic token으로 매핑 |
| `apps/desktop/src/desktop-service.ts` | Application DTO를 설정·Registry·Extension view model로 투영 |
| `apps/desktop/src/desktop-service.test.ts` | 신규 Desktop service query/command 투영 검증 |
| `apps/desktop/src/app.tsx` | bootstrap과 공통 셸 조립만 소유 |
| `apps/desktop/src/shell/*` | Sidebar, Header, Command palette |
| `apps/desktop/src/surfaces/*` | 대표·홈, 조직, 결정, 성장, 역량, 설정의 개별 UI |
| `apps/desktop/src/app.test.tsx` | 화면 전환·설정·설치 요청의 사용자 행위 검증 |

## Task 1: Extension과 Registry 운영 조립

**Files:**

- Modify: `apps/server/src/product.ts:18-42, 203-217, 692-787`
- Modify: `apps/server/src/product.test.ts`
- Reuse: `packages/extension-host/src/{lifecycle,gateway,governance-adapter,package-service,worker-supervisor}.ts`
- Reuse: `packages/registry/src/{installer,application-adapter}.ts`

- [ ] **Step 1: 실패하는 서버 product test를 추가합니다.**

  `createMassionDaemon()`으로 local config daemon을 만들고 owner access token으로 다음 query를 실행합니다.

  ```ts
  const response = await client.query("extension.list", {});
  expect(response).toMatchObject({ operation: "extension.list", data: [] });

  await expect(client.query("registry.info", { versionId: "missing-registry-version" }))
    .rejects.not.toThrow("Registry가 구성되지 않았습니다");
  ```

  Test: `apps/server/src/product.test.ts`

- [ ] **Step 2: 새 test가 현재 production wiring 부재로 실패하는 것을 확인합니다.**

  Run: `pnpm --filter @massion/server test -- src/product.test.ts`

  Expected: `extension.list`가 등록되지 않았거나 `registry.info`가 Product fallback의 “Registry가 구성되지 않았습니다” 오류를 내므로 test가 실패합니다.

- [ ] **Step 3: 같은 artifact root와 governance gate로 Extension runtime을 조립합니다.**

  `ExtensionStore.create()`의 결과를 보존하고 `FileArtifactStore`, `ExtensionWorkerSupervisor`, `GovernanceExtensionAuthorizer`, `ExtensionLifecycleService`, `ExtensionPackageService`, `ExtensionGateway`를 만듭니다. `ApplicationProduct.create()`에 다음 의존성을 넘깁니다.

  ```ts
  domain: { /* existing */, extension: extensionGateway },
  queries: { /* existing */, extension: extensionGateway },
  artifacts: applicationArtifactGateway,
  registry: registryApplicationAdapter,
  ```

  `RegistryInstaller`와 `RegistryApplicationAdapter`는 위 lifecycle/artifact store를 재사용해야 합니다. 별도 worker, 별도 artifact store, 권한 우회 경로를 만들지 않습니다.

- [ ] **Step 4: focused server test를 다시 실행합니다.**

  Run: `pnpm --filter @massion/server test -- src/product.test.ts`

  Expected: PASS.

- [ ] **Step 5: 변경 파일만 커밋합니다.**

  ```bash
  git add apps/server/src/product.ts apps/server/src/product.test.ts
  git commit -m "feat: Extension Registry 운영 경로 연결"
  ```

## Task 2: shadcn Base UI 기준선과 제품 토큰

**Files:**

- Modify: `apps/desktop/components.json`
- Modify: `apps/desktop/package.json`, `pnpm-lock.yaml`
- Modify: `apps/desktop/src/styles.css`
- Create: 필요한 `apps/desktop/src/components/ui/{sidebar,resizable,scroll-area,separator,command,input,field,select,switch,alert,alert-dialog,dropdown-menu}.tsx`

- [ ] **Step 1: 현재 CLI 오류를 재현합니다.**

  Run: `pnpm dlx shadcn@latest info`

  Expected: 기존 `style: new-york`과 `base: base-ui` 조합을 CLI가 invalid configuration으로 거부합니다.

- [ ] **Step 2: 최신 Base UI 설정과 semantic token test를 먼저 작성합니다.**

  `apps/desktop/src/styles.test.ts`를 만들고 다음 최소 계약을 검사합니다.

  ```ts
  it("제품 token이 shadcn background·sidebar token으로 매핑된다", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toContain("--color-background: var(--canvas)");
    expect(css).toContain("--color-sidebar");
  });
  ```

- [ ] **Step 3: test가 token 부재로 실패하는 것을 확인합니다.**

  Run: `pnpm --filter @massion/desktop test -- src/styles.test.ts`

  Expected: semantic shadcn token assertion failure.

- [ ] **Step 4: config를 `base-nova` Base UI style로 복구하고 필요한 source만 추가합니다.**

  `components.json`에서 구형 `base` 필드를 제거하고 style을 `base-nova`로 바꿉니다. `pnpm dlx shadcn@latest add`는 아래 이름만 사용하고 `--all`과 `--overwrite`는 사용하지 않습니다.

  ```bash
  pnpm dlx shadcn@latest add sidebar resizable scroll-area separator command input field select switch alert alert-dialog dropdown-menu
  ```

  생성 source는 Phosphor를 쓰는 기존 app과 충돌하지 않게 검토하고, `styles.css`에는 기존 amber/dark token을 semantic shadcn token으로 매핑합니다.

- [ ] **Step 5: CLI·focused test·build를 확인합니다.**

  Run: `pnpm dlx shadcn@latest info && pnpm --filter @massion/desktop test -- src/styles.test.ts && pnpm --filter @massion/desktop build`

  Expected: PASS.

- [ ] **Step 6: 변경 파일만 커밋합니다.**

  ```bash
  git add apps/desktop/components.json apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/components/ui apps/desktop/src/styles.css apps/desktop/src/styles.test.ts
  git commit -m "feat: 데스크톱 shadcn Base UI 기반 정비"
  ```

## Task 3: 7개 표면 공통 셸과 기존 Work 이전

**Files:**

- Modify: `apps/desktop/src/app.tsx`
- Modify: `apps/desktop/src/app.test.tsx`
- Create: `apps/desktop/src/shell/{desktop-shell,app-sidebar,desktop-header,command-menu}.tsx`
- Create: `apps/desktop/src/surfaces/{representative,organization,decisions,growth,capabilities,settings}/*-surface.tsx`

- [ ] **Step 1: 7개 표면의 독립 이동 test를 추가합니다.**

  ```tsx
  it.each([
    ["대표·홈", "대표·홈"], ["업무", "업무"], ["조직", "조직"],
    ["결정", "결정"], ["성장", "성장"], ["역량", "역량"], ["설정", "설정"],
  ])("%s 표면으로 이동한다", async (label, mainName) => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: label }));
    expect(await screen.findByRole("main", { name: mainName })).toBeInTheDocument();
  });
  ```

- [ ] **Step 2: test가 기존 5개 메뉴와 대표=업무 별칭 때문에 실패하는지 확인합니다.**

  Run: `pnpm --filter @massion/desktop test -- src/app.test.tsx`

  Expected: 대표·홈, 결정, 성장, 역량, 설정 중 하나 이상을 찾지 못해 FAIL.

- [ ] **Step 3: 공통 셸을 추가하고 Work 상세를 `work` 표면으로 보존합니다.**

  `DesktopShell`이 `SidebarProvider`, `AppSidebar`, Header, `SidebarInset`을 조립합니다. `App`은 bootstrap, `SurfaceId` 상태, controller와 `NewWorkDialog`만 보유합니다. 기존 Work 목록·활동·Inspector는 `ResizablePanelGroup` 안으로 옮기되 Work command와 controller 호출을 변경하지 않습니다.

  임시 구형 메뉴 `확인 필요`, `자동화`, `확장`은 각각 `결정`, `설정`, `역량` 표면의 첫 view로 흡수합니다. 조직·결정·성장은 현재 읽기 가능한 데이터만 보이고, 지원되지 않는 mutation은 만들지 않습니다.

- [ ] **Step 4: focused UI test와 build를 실행합니다.**

  Run: `pnpm --filter @massion/desktop test -- src/app.test.tsx && pnpm --filter @massion/desktop build`

  Expected: PASS; 기존 Work 생성·지시·승인·취소·재개 흐름도 동일 test에서 통과.

- [ ] **Step 5: 변경 파일만 커밋합니다.**

  ```bash
  git add apps/desktop/src/app.tsx apps/desktop/src/app.test.tsx apps/desktop/src/shell apps/desktop/src/surfaces
  git commit -m "feat: AgentOS 7개 운영 표면 셸 구성"
  ```

## Task 4: Provider·계정·모델 경로 설정

**Files:**

- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/desktop-service.test.ts`
- Modify: `apps/desktop/src/surfaces/settings/settings-surface.tsx`
- Modify: `apps/desktop/src/app.test.tsx`

- [ ] **Step 1: provider 설정 view model을 요구하는 service test를 작성합니다.**

  ```ts
  it("Provider catalog·credential·route·doctor를 설정 view로 함께 투영한다", async () => {
    const settings = await service.loadProviderSettings();
    expect(settings.providers).toHaveLength(1);
    expect(settings.credentials[0]).not.toHaveProperty("secret");
    expect(settings.doctor[0]).toMatchObject({ action: "reauth" });
  });
  ```

  `ApplicationClient` mock에는 `router.catalog`, `router.credentials`, `router.routes`, `subscription.providers`, `subscription.accounts`, `subscription.quota`, `subscription.policy`, `subscription.doctor`의 실제 응답 모양을 제공합니다.

- [ ] **Step 2: test가 아직 `loadProviderSettings`가 없어 실패하는 것을 확인합니다.**

  Run: `pnpm --filter @massion/desktop test -- src/desktop-service.test.ts`

  Expected: TypeScript 또는 runtime에서 `loadProviderSettings` 부재로 FAIL.

- [ ] **Step 3: 최소 service와 설정 UI를 구현합니다.**

  `DesktopService.loadProviderSettings()`은 위 query를 병렬 조회하고 화면에 필요한 목록만 투영합니다. API credential 저장은 `router.credential.add` command를 사용하고 secret은 `submitCredential()` 함수의 지역 변수로만 다룹니다. 성공·실패 어느 경우에도 input state를 비웁니다. 연결 해제는 기존 `router.credential.disable`의 실제 revoke 의미를 UI에 “폐기”로 표시합니다.

  Settings surface는 `Provider 및 계정`, `모델 및 경로`, `권한 및 자동화`, `고급`만 구현합니다. 저장/백업/알림은 backend 계약이 준비되기 전에는 navigation item을 만들지 않습니다.

- [ ] **Step 4: focused test와 build를 확인합니다.**

  Run: `pnpm --filter @massion/desktop test -- src/desktop-service.test.ts src/app.test.tsx && pnpm --filter @massion/desktop build`

  Expected: PASS.

- [ ] **Step 5: 변경 파일만 커밋합니다.**

  ```bash
  git add apps/desktop/src/desktop-service.ts apps/desktop/src/desktop-service.test.ts apps/desktop/src/surfaces/settings apps/desktop/src/app.test.tsx
  git commit -m "feat: Provider와 모델 경로 설정 표면 추가"
  ```

## Task 5: Registry Extension 설치와 역량 표면

**Files:**

- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/desktop-service.test.ts`
- Modify: `apps/desktop/src/surfaces/capabilities/capabilities-surface.tsx`
- Modify: `apps/desktop/src/app.test.tsx`

- [ ] **Step 1: Registry 검색·설치 대기 상태 test를 추가합니다.**

  ```ts
  it("Registry 설치가 승인 대기면 approval id를 보존한다", async () => {
    const result = await service.installRegistryExtension({
      versionId: "registry-version-1", environment: "local", riskClass: "extension-install", executionId: "surface:test",
    });
    expect(result).toEqual({ status: "awaiting-approval", approvalId: "approval-1" });
  });
  ```

- [ ] **Step 2: test가 Registry desktop method 부재로 실패하는 것을 확인합니다.**

  Run: `pnpm --filter @massion/desktop test -- src/desktop-service.test.ts`

  Expected: `installRegistryExtension` 부재로 FAIL.

- [ ] **Step 3: Registry service와 역량 UI를 구현합니다.**

  `searchRegistryExtensions`, `loadRegistryExtensionInfo`, `loadRegistryInventory`, `installRegistryExtension`만 추가합니다. `registry.install`의 `awaiting-approval` 결과는 실패로 바꾸지 않고 approval id를 그대로 투영합니다.

  역량 표면은 `역량`, `설치됨`, `찾기` 세 tabs를 둡니다. 찾기에서 search → info → permission/contribution 검토 → install 요청까지 연결하고, 승인 대기는 결정 표면으로 이동하는 행동만 제공합니다. disable/remove, local filesystem package 선택, 가짜 activation toggle은 구현하지 않습니다.

- [ ] **Step 4: focused test와 build를 확인합니다.**

  Run: `pnpm --filter @massion/desktop test -- src/desktop-service.test.ts src/app.test.tsx && pnpm --filter @massion/desktop build`

  Expected: PASS.

- [ ] **Step 5: 변경 파일만 커밋합니다.**

  ```bash
  git add apps/desktop/src/desktop-service.ts apps/desktop/src/desktop-service.test.ts apps/desktop/src/surfaces/capabilities apps/desktop/src/app.test.tsx
  git commit -m "feat: Registry Extension 설치 표면 연결"
  ```

## Task 6: 변경 경계 통합 검증과 리뷰

**Files:**

- Modify only when a failing focused verification reveals a real integration defect.

- [ ] **Step 1: Desktop와 server의 변경 경계 test를 실행합니다.**

  Run:

  ```bash
  pnpm --filter @massion/server test -- src/product.test.ts
  pnpm --filter @massion/desktop test
  pnpm --filter @massion/desktop build
  ```

  Expected: PASS.

- [ ] **Step 2: 수동 smoke를 수행합니다.**

  1. 설정에서 Provider 상태를 열어 secret이 목록에 없는지 확인합니다.
  2. 역량에서 Registry 후보를 열고 권한·기여를 확인합니다.
  3. install이 승인 대기일 때 결정 표면으로 이동할 수 있는지 확인합니다.
  4. Work 화면에서 기존 지시·승인 행동이 그대로 동작하는지 확인합니다.

- [ ] **Step 3: 구현 task별 spec compliance review 후 code-quality review를 수행합니다.**

  리뷰는 이 계획과 [제품 표면 설계](../specs/2026-07-22-massion-desktop-product-surfaces-design.md)의 범위만 봅니다. 변경되지 않은 Web/TUI나 전체 저장소 반복 회귀는 실행하지 않습니다.

- [ ] **Step 4: 검증 증거와 최종 변경만 커밋합니다.**

  ```bash
  git add <실제 수정된 파일>
  git commit -m "test: 데스크톱 AgentOS 표면 통합 검증"
  ```

## 계획 자체 검토

- **Spec coverage:** 7개 표면은 Task 3, Provider·인증은 Task 4, Extension production wiring과 설치는 Task 1·5, shadcn 공통 셸은 Task 2·3, 안전한 disable/remove 제외는 Task 5에 반영했습니다.
- **의도적 제외:** 동적 조직 mutation, Growth 채택, Extension disable/remove은 각 도메인의 세로 흐름 계약이 이 작업 트리에서 아직 완성되지 않았으므로 UI만 만들어 완료처럼 보이게 하지 않습니다.
- **Type consistency:** Desktop service method는 `loadProviderSettings`, `searchRegistryExtensions`, `loadRegistryExtensionInfo`, `loadRegistryInventory`, `installRegistryExtension`으로 고정합니다. Registry install 결과는 `succeeded | awaiting-approval`만 UI로 투영합니다.
