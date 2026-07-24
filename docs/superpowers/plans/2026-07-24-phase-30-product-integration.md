# Phase 30 제품 통합 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `subagent-driven-development`(권장) 또는 `executing-plans`로 작업을 순서대로 수행합니다. 각 단계는 체크박스로 추적하며, 공용 파일은 현재 작업 조각만 스테이징합니다.

**Goal:** Z.AI Coding Plan `glm-5.2`를 개발·테스트 에이전트로 활용해 완성본 데스크톱 UI를 실제 Core·조직·개선·확장·설정 계약에 연결하고, Tauri 앱에서 최소 12개 핵심 사용자 시나리오와 개인용 배포 게이트를 통과시킵니다.

**Architecture:** 홈과 새 사명 입력을 먼저 닫은 뒤 Core Work 완주를 첫 세로 흐름으로 고정합니다. 이후 협업·조직, 개선, 확장·설정을 같은 query/command/event 경계에 붙이고 실제 UAT에서 발견된 문제에만 최소 회귀 테스트를 추가합니다.

**Tech Stack:** TypeScript 5.9, React 19, Tauri 2, Rust, Vitest, SurrealDB 3.2.1, VoltAgent, 개인 BYOK Z.AI Coding Plan `glm-5.2`, Computer Use

---

## 1. 실행 규칙

- 각 작업은 독립 커밋이 가능한 크기로 끝냅니다.
- 안전·권한·revision·멱등·완료 판정의 최소 사양 테스트만 먼저 작성합니다.
- 나머지는 실제 시나리오를 먼저 실행하고 실패한 경우에만 회귀 테스트 하나를 추가합니다.
- fixture 화면의 시각 완성도는 보존하고 실데이터 연결 때문에 레이아웃을 다시 만들지 않습니다.
- 한 조각의 표적 테스트가 통과하기 전 다음 도메인으로 넘어가지 않습니다.
- 전체 `pnpm verify`는 매 작은 수정마다 돌리지 않고 단계 종료와 최종 후보에서 실행합니다.
- 구현·테스트 작성·실패 분석·패치와 개인용 로컬 도그푸딩에 Z.AI Coding Plan `glm-5.2`를 사용합니다. GLM이 제안한 변경도 같은 표적 검사와 실제 UAT를 통과해야 채택합니다.

## 2. 파일 책임 맵

| 경로 | 책임 |
|---|---|
| `packages/application/src/contracts.ts` | typed query·command·event 공개 계약 |
| `packages/application/src/query-registry.ts` | 도메인 read model의 공개 projection |
| `packages/application/src/adapters/domain.ts` | 공개 변경 명령과 revision·멱등 경계 |
| `packages/application/src/adapters/read-model.ts` | Work·조직·협업 실데이터 조회 |
| `packages/application/src/core-*.ts` | Work 6단계와 완료 불변량 |
| `packages/application/src/collaboration-delta-recorder.ts` | 실제 위임의 방 메시지 기록 |
| `packages/runtime/src/contracts.ts` | 안전한 delegation delta |
| `packages/runtime/src/voltagent-runner.ts` | Provider stream에서 안전 필드 추출 |
| `packages/workspace/src/workspace.ts` | canonical directory와 신뢰 경계 |
| `apps/server/src/product.ts` | recorder·gateway·status의 생산 조립 |
| `apps/desktop/src/desktop-service.ts` | Application 계약→화면 뷰 연결 |
| `apps/desktop/src/use-desktop-controller.ts` | Work 입력 draft와 사용자 명령 상태 |
| `apps/desktop/src/app.tsx` | 홈·업무·조직·개선·확장·설정 UI |
| `apps/desktop/src/native-context-picker.ts` | 네이티브 폴더·파일 선택 |
| `apps/desktop/src-tauri/**` | Tauri plugin과 최소 capability |
| `docs/evidence/phase-30/**` | 실제 명령·앱 조작·스크린샷 근거 |

## Task 1: 데스크톱 추적 소스 lint 기준선 복구

**Files:**

- Modify: `apps/desktop/src/app.tsx`
- Modify as reported: other tracked files under `apps/desktop/src/**`

- [ ] **Step 1: dirty worktree 전체 lint 실패와 제품 소스 실패를 구분합니다.**

Run: `pnpm lint`

Expected in the current worktree: 사용자 소유 `existing-data-capture.*` 안 제3자 config에서 `Unexpected non-object config`로 중단합니다. 이 디렉터리를 삭제하거나 제품 설정에 임시 이름을 박지 않습니다.

- [ ] **Step 2: 데스크톱 추적 소스만 검사합니다.**

Run: `pnpm exec eslint apps/desktop/src`

Expected at plan creation: 실제 strict lint 오류 78건.

- [ ] **Step 3: 기계적 오류만 정리합니다.**

unused import·불필요 assertion/optional chain을 삭제하고 void shorthand에 braces를 추가합니다. deprecated `FormEvent`는 현재 React 타입이 권장하는 `SyntheticEvent<HTMLFormElement>`로 바꿉니다. lint를 피하려고 rule을 끄거나 별도 config를 만들지 않습니다.

- [ ] **Step 4: lint·타입·기존 UI 테스트를 확인합니다.**

Run: `pnpm exec eslint apps/desktop/src && pnpm --filter @massion/desktop typecheck && pnpm --filter @massion/desktop test`

Expected: 세 명령 exit 0.

- [ ] **Step 5: 커밋합니다.**

```sh
git add apps/desktop/src
git commit -m "refactor(desktop): strict lint 기준선 정리" \
  -m "동작 변경 없이 데스크톱 추적 소스의 strict TypeScript lint 오류를 제거했습니다."
```

전체 `pnpm lint`는 untracked 산출물이 없는 Task 11 clean clone에서 판정합니다.

## Task 2: 홈과 새 사명 입력을 실 워크스페이스에 연결

**Files:**

- Modify: `packages/workspace/src/workspace.ts`
- Modify: `packages/workspace/src/workspace.test.ts`
- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/core-pipeline.ts`
- Modify: `packages/application/src/adapters/domain.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/use-desktop-controller.ts`
- Modify: `apps/desktop/src/app.tsx`
- Modify: `apps/desktop/src/app.integration.test.tsx`

- [ ] **Step 1: Workspace query·command를 typed map에 등록합니다.**

`2026-07-24-desktop-home-context-design.md` §4의 `WorkspaceViewV1`, `workspace.list`, `workspace.get`, `workspace.register`, `workspace.trust`, `workspace.archive`를 그대로 추가합니다. 이미 등록된 handler를 새로 만들지 않습니다.

- [ ] **Step 2: 실제 디렉터리 경계를 한 테스트로 고정합니다.**

`workspace.test.ts`에 임시 디렉터리, 일반 파일, 외부를 가리키는 symlink를 한 사례 표로 추가합니다. 디렉터리는 통과하고 나머지는 거부해야 합니다.

Run: `pnpm --filter @massion/workspace test`

Expected: 새 경계 테스트가 구현 전 실패하고 최소 `realpath`·`stat` 검증 뒤 통과.

- [ ] **Step 3: Work 입력에 `workspacePaths`를 추가합니다.**

상대 경로만 받고 workspace 없는 경로, 절대 경로, `..` 탈출을 거부합니다. `scopeIn` 자유 문구를 파일 경로 검증에 재사용하지 않습니다.

- [ ] **Step 4: 데스크톱의 raw workspace ID 입력을 삭제합니다.**

`DesktopService`에 workspace 조회·등록·신뢰 메서드를 추가하고 `NewWorkDialog`에는 저장된 폴더 목록과 `폴더 추가` 버튼을 둡니다. 기존 요청 draft 보존·중복 실행 잠금과 run 계보 자동 선택은 유지합니다.

- [ ] **Step 5: 내부 ID 없는 사용자 행동을 한 통합 테스트로 고정합니다.**

대화상자에서 이름으로 workspace를 선택하고 파일 상대 경로가 `startWork({ text, workspaceId, workspacePaths })`에 전달되는지만 검사합니다. 선택기 자체는 mock 세부 테스트를 만들지 않습니다.

Run: `pnpm --filter @massion/desktop test && pnpm --filter @massion/desktop typecheck`

Expected: 67개 기존 테스트와 새 집중 테스트 통과.

- [ ] **Step 6: 계약과 표면을 분리 커밋합니다.**

```sh
git add packages/workspace/src packages/application/src/contracts.ts packages/application/src/core-pipeline.ts packages/application/src/adapters/domain.ts packages/application/src/query-registry.ts
git commit -m "feat(core): 워크스페이스 입력 경계 타입화" \
  -m "실제 디렉터리 검증과 상대 파일 문맥을 Work 시작 계약에 연결했습니다."

git add apps/desktop/src/desktop-service.ts apps/desktop/src/use-desktop-controller.ts apps/desktop/src/app.tsx apps/desktop/src/app.integration.test.tsx
git commit -m "feat(desktop): 새 사명에 워크스페이스 선택 연결" \
  -m "내부 ID 입력을 제거하고 저장된 폴더 선택·신뢰·파일 문맥을 홈 진입 흐름에 연결했습니다."
```

## Task 3: Tauri 네이티브 폴더·파일 선택 추가

**Files:**

- Create: `apps/desktop/src/native-context-picker.ts`
- Create: `apps/desktop/src/native-context-picker.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 공식 Tauri dialog plugin만 추가합니다.**

범용 filesystem plugin과 custom file browser는 추가하지 않습니다. capability는 폴더·파일 열기 대화상자에 필요한 권한만 허용합니다.

- [ ] **Step 2: picker 반환을 작은 함수로 정규화합니다.**

```ts
export interface NativeContextPicker {
  pickDirectory(): Promise<string | undefined>;
  pickFiles(): Promise<readonly string[]>;
}
```

취소는 `undefined` 또는 빈 배열이며 예외가 아닙니다.

- [ ] **Step 3: 반환 정규화 테스트 하나와 실제 dialog UAT를 구분합니다.**

테스트는 단일/복수/취소 반환 형태만 검사합니다. 버튼 클릭과 OS dialog는 UAT-04·05에서 확인합니다.

Run: `pnpm --filter @massion/desktop test && cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: exit 0.

- [ ] **Step 4: 커밋합니다.**

```sh
git add apps/desktop/package.json apps/desktop/src/native-context-picker.ts apps/desktop/src/native-context-picker.test.ts apps/desktop/src-tauri pnpm-lock.yaml
git commit -m "feat(desktop): 네이티브 작업 문맥 선택 추가" \
  -m "Tauri 공식 대화상자로 사용자 선택 폴더와 파일 경로만 받아 새 사명 흐름에 전달합니다."
```

## Task 4: 실제 Core Work 한 줄 검증과 발견 문제 패치

**Files:**

- Modify only if failure proves it: `packages/application/src/core-*.ts`, `apps/server/src/product.ts`, `apps/desktop/src/use-desktop-controller.ts`, `apps/desktop/src/desktop-service.ts`
- Test: 최초 어긋난 공통 계층의 기존 `*.test.ts`
- Create: `docs/evidence/phase-30/desktop-core-uat-2026-07-24.md`

- [ ] **Step 1: GLM 키와 모델 경로를 비밀 출력 없이 확인합니다.**

```sh
set +x
source ~/.zshrc
test -n "${Z_AI_API_KEY:-}"
```

Expected: exit 0, stdout 없음.

- [ ] **Step 2: 격리 데이터와 fixture workspace로 Tauri dev 앱을 실행합니다.**

`XDG_*`와 workspace fixture 경로는 evidence에 기록하되 사용자 홈 절대 경로는 마스킹합니다.

- [ ] **Step 3: UAT-01~06과 UAT-12를 Computer Use로 실행합니다.**

각 행동 뒤 접근성 트리를 다시 읽고 필요한 화면만 캡처합니다.

- [ ] **Step 4: 실패가 나오면 그 사례만 재현합니다.**

최초 어긋난 계층에 회귀 테스트 한 개를 추가하고 공통 경로를 고칩니다. 성공한 경로를 예상해 테스트를 늘리지 않습니다.

- [ ] **Step 5: Core 관련 패키지와 실패 UAT를 다시 실행합니다.**

Run: `pnpm --filter @massion/application test && pnpm --filter @massion/server test && pnpm --filter @massion/desktop test`

Expected: 각각 현재 기준 324, 237, 67개 이상 통과하고 건너뜀 수가 의도 없이 늘지 않음.

- [ ] **Step 6: 코드와 증거를 분리 커밋합니다.**

코드 수정이 없으면 코드 커밋을 만들지 않습니다. 수정이 있으면 원인별 커밋 후 evidence 문서를 별도 커밋합니다.

## Task 5: 실제 위임을 협업방에 기록

**Files:**

- Modify: `packages/runtime/src/contracts.ts`
- Modify: `packages/runtime/src/voltagent-runner.ts`
- Modify: `packages/runtime/src/voltagent-runner.test.ts`
- Create: `packages/application/src/collaboration-delta-recorder.ts`
- Create: `packages/application/src/collaboration-delta-recorder.test.ts`
- Modify: `apps/server/src/product.ts`
- Modify: `apps/server/src/product.test.ts`

- [ ] **Step 1: `delegate_task`의 안전 필드만 델타에 남깁니다.**

`targetAgentHandle`과 1,000자 이하 objective만 보존하고 일반 tool input·credential·prompt는 제거합니다.

- [ ] **Step 2: request/answer 영속과 멱등을 통합 테스트 한 개로 먼저 고정합니다.**

같은 toolCall 재전달은 메시지를 늘리지 않고, answer는 request를 `replyToMessageId`로 가리켜야 합니다.

- [ ] **Step 3: execution별 Promise queue 기록기를 구현합니다.**

기록 실패는 observer 밖으로 던지지 않고 주입된 logger에 구조화해 남깁니다. 종료 flush는 현재 daemon shutdown 순서에 한 단계로 추가합니다.

- [ ] **Step 4: 기존 execution stream과 기록기를 한 observer 객체로 조립합니다.**

새 observer framework를 만들지 않습니다.

Run: `pnpm --filter @massion/runtime test && pnpm --filter @massion/application test && pnpm --filter @massion/server test`

Expected: exit 0.

- [ ] **Step 5: UAT-07을 실행하고 커밋합니다.**

```sh
git add packages/runtime/src/contracts.ts packages/runtime/src/voltagent-runner.ts packages/runtime/src/voltagent-runner.test.ts packages/application/src/collaboration-delta-recorder.ts packages/application/src/collaboration-delta-recorder.test.ts apps/server/src/product.ts apps/server/src/product.test.ts
git commit -m "feat(core): 실제 에이전트 위임을 협업방에 기록" \
  -m "delegate_task 요청과 응답을 멱등한 handoff·answer 메시지로 남기고 기록 실패를 실행에서 격리했습니다."
```

## Task 6: 조직 구조·지도·제안 계약 연결

**Files:**

- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/adapters/read-model.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/app.tsx`
- Modify: related Application/Desktop tests

- [ ] `parent_handle`·`scope`·`work_id` 실 projection을 추가합니다.
- [ ] 범용 `organization.command` payload를 discriminated union으로 타입화합니다.
- [ ] Work별·전역 조직 제안 조회를 같은 projection으로 추가합니다.
- [ ] 구조↔지도 선택 동기화는 현재 UI를 유지하고 fixture만 실제 snapshot으로 교체합니다.
- [ ] drag는 영향 미리보기와 승인 뒤에만 실제 move를 보냅니다.
- [ ] stale revision 거부와 snapshot 재조회만 자동 검사합니다.
- [ ] UAT-13을 실행합니다.

Run: `pnpm --filter @massion/application test && pnpm --filter @massion/desktop test`

Expected: exit 0.

Commit:

```sh
git commit -m "feat(organization): 조직 제안과 실계층을 데스크톱에 연결" \
  -m "구조와 지도가 같은 snapshot을 사용하고 편성 변경이 영향·승인·revision을 거치도록 연결했습니다."
```

## Task 7: 개선의 평가·결정·효과 연결

**Files:**

- Modify: `packages/growth/src/**`의 suggestion 상태 소유 파일
- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/adapters/domain.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/app.tsx`
- Modify: related tests

- [ ] 상세 제안·평가·신호·adoption·측정 효과 조회를 타입화합니다.
- [ ] 기존 `growth.adopt`·`growth.revert`를 유지하고 제품 이름 별칭을 추가합니다.
- [ ] 명시적 reject를 도메인에 추가해 사유와 revision을 영속합니다.
- [ ] Growth 사건으로 개선과 수신함 query를 무효화합니다.
- [ ] fixture를 제거하고 기존 완성본 뷰 타입을 실제 데이터로 채웁니다.
- [ ] 평가 없음·checksum drift·reject 기록만 한 표 기반 테스트로 고정합니다.
- [ ] UAT-14를 실행합니다.

Run: `pnpm --filter @massion/growth test && pnpm --filter @massion/application test && pnpm --filter @massion/desktop test`

Expected: exit 0.

Commit:

```sh
git commit -m "feat(growth): 개선 평가와 사용자 결정을 연결" \
  -m "근거·반대 신호·diff를 실제 조회로 제공하고 승인·거절·효과·되돌리기를 같은 계보로 연결했습니다."
```

## Task 8: 설치된 확장의 Capability와 실제 Tool 연결

**Files:**

- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `packages/extension-host/src/store.ts` 또는 active manifest 조회 seam
- Modify: `apps/server/src/product.ts`
- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/app.tsx`
- Modify: related tests

- [ ] `extension.list`에 contributions·permissions를 추가합니다.
- [ ] `registry.search`·`info`·`inventory`를 타입화합니다.
- [ ] 공식 최소 확장의 runtime tool 하나만 Agent tool catalog에 연결합니다.
- [ ] Tool 사용이 Work execution·approval·audit에 남는 제품 테스트 한 개를 만듭니다.
- [ ] UAT-15를 실행합니다.

Run: `pnpm --filter @massion/extension-host test && pnpm --filter @massion/application test && pnpm --filter @massion/server test && pnpm --filter @massion/desktop test`

Expected: exit 0.

Commit:

```sh
git commit -m "feat(extension): 설치 Capability를 실제 Work 실행에 연결" \
  -m "설치 manifest의 선언과 권한을 노출하고 공식 runtime tool 하나를 승인·감사 가능한 Agent 실행에 연결했습니다."
```

## Task 9: 설정 타입과 로컬 운영 상태 연결

**Files:**

- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `apps/server/src/product.ts`
- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/app.tsx`
- Modify: related tests

- [ ] 일곱 Router·Subscription query를 기존 handler 모양 그대로 타입화합니다.
- [ ] credential view에 secret 필드가 없음을 컴파일 가능한 계약으로 고정합니다.
- [ ] `local.runtime.status`를 추가합니다.
- [ ] 데스크톱 `unknown` 필드와 세 projection helper, 범용 파싱 helper를 삭제합니다.
- [ ] UAT-16을 실행합니다.

Run: `pnpm --filter @massion/application test && pnpm --filter @massion/server test && pnpm --filter @massion/desktop test`

Expected: exit 0.

Commit:

```sh
git commit -m "refactor(settings): 운영 조회를 타입 계약으로 수렴" \
  -m "Router·Subscription·로컬 runtime 조회를 타입화하고 데스크톱의 unknown 런타임 파서를 제거했습니다."
```

## Task 10: 전역 집계와 실제 앱 회귀 확인

**Files:**

- Modify: `apps/desktop/src/app.tsx`
- Modify: `apps/desktop/src/app.integration.test.tsx`
- Modify only if needed: Growth/Organization public event projection

- [ ] App의 단일 `InboxItem` projection에 pending organization proposal을 추가합니다.
- [ ] 홈·수신함·배지가 같은 배열을 계속 사용하도록 확인합니다.
- [ ] 소유 화면이 있는 항목은 수신함에서 결정하지 않고 이동만 제공합니다.
- [ ] UAT에서 숫자 불일치가 발견된 경우에만 통합 테스트 한 건을 추가합니다.

Run: `pnpm --filter @massion/desktop test && pnpm --filter @massion/desktop typecheck`

Expected: exit 0.

## Task 11: 최종 데스크톱 UAT와 개인용 릴리스 게이트

**Files:**

- Create: `docs/evidence/phase-30/desktop-live-uat-2026-07-24.md`
- Create: `docs/evidence/phase-30/personal-desktop-release-YYYY-MM-DD.md`
- Create: `scripts/verify-desktop-release.mjs`
- Create: `scripts/verify-desktop-release.test.mjs`
- Create: `.github/workflows/desktop-release.yml`
- Modify: `apps/desktop/src-tauri/tauri.release.conf.json`
- Modify only if abnormal recovery fails: `packages/local-control/src/daemon.ts`, `apps/desktop-bridge/src/application-adapter.ts`, `apps/desktop/src/desktop-service.ts`
- Modify: `PRODUCT.md`
- Modify: `docs/product/constitution.md`
- Modify: `docs/generated/requirements-traceability.tsv`

- [ ] **Step 1: 같은 후보 SHA에서 전체 게이트를 실행합니다.**

```sh
pnpm verify
pnpm --filter @massion/desktop tauri:build
```

Expected: 모두 exit 0. `pnpm verify:release`는 레거시 CLI·TUI·Web 묶음 검사라 개인용 데스크톱 완료 근거에서 제외합니다. 실패하면 UAT를 시작하지 않습니다.

- [ ] **Step 2: 빌드된 `.app`으로 UAT-01~16을 실행합니다.**

최소 조건은 핵심 UAT-01~12 전부와 구현된 UAT-13~16 전부 통과입니다. 한 건이라도 실패하면 완료로 표시하지 않습니다.

- [ ] **Step 3: 재시작과 영속 상태를 다시 확인합니다.**

Work, 협업 메시지, 승인 결과, 조직 version, 개선 adoption, 확장 상태가 앱 재실행 뒤 동일해야 합니다.

- [ ] **Step 4: macOS arm64 배포 신원을 검증합니다.**

Developer ID 서명과 Apple 공증을 같은 후보 SHA에서 수행합니다. 인증서는 CI secret으로만 주입하고 로그에 신원 외 비밀을 남기지 않습니다. 생성된 `.app` 또는 `.dmg`에 다음 검사를 실행합니다.

```sh
codesign --verify --deep --strict --verbose=2 Massion.app
spctl --assess --type execute --verbose=4 Massion.app
xcrun stapler validate Massion.app
```

세 명령과 앱 내부 Node.js·SurrealDB sidecar 서명 검사가 모두 통과해야 합니다. Ad-hoc 서명은 공개 후보로 인정하지 않습니다.

- [ ] **Step 5: 깨끗한 Mac 설치·업데이트·제거를 검증합니다.**

개발 도구와 Massion 데이터가 없는 macOS arm64 사용자에서 최초 실행과 Gatekeeper 통과를 확인합니다. 이전 서명 후보를 설치한 상태에서 새 후보로 앱을 교체하는 수동 업데이트를 수행하고 Work·설정·데이터가 유지되는지 확인합니다. 앱을 제거한 뒤 데이터 보존 정책을 확인하고 재설치해 같은 데이터에 재연결합니다. 자동 업데이트 기능은 첫 1.0 필수 사양으로 만들지 않으며, 수동 교체가 실패할 때만 Tauri updater를 별도 범위로 추가합니다.

- [ ] **Step 6: 비정상 종료와 데이터 무결성을 검증합니다.**

실행 중 daemon과 SurrealDB sidecar를 각각 강제 종료하고 앱 재연결을 확인합니다. 재시작 뒤 Work·event·message가 중복되지 않고, 마지막 확정 transaction 이전 상태로 일관되게 복원되며, 데이터베이스 readiness와 핵심 query가 통과해야 합니다. 실패한 공통 경로에만 회귀 테스트 한 건을 추가합니다.

- [ ] **Step 7: 키보드·VoiceOver 접근성을 실측합니다.**

마우스 없이 UAT-01~12를 수행하고 모든 조작 요소의 초점 표시·논리적 순서·대화상자 복귀를 확인합니다. VoiceOver와 Accessibility Inspector로 홈·업무·수신함·조직 구조/지도·개선·확장·설정의 이름(name), 역할(role), 상태(state), 행동(action)을 확인합니다. 클릭 가능한데 VoiceOver로 실행할 수 없는 요소나 핵심 흐름을 막는 경고는 릴리스 차단입니다.

- [ ] **Step 8: 개인 BYOK 경계를 증명합니다.**

구현·테스트 작성·실패 분석·패치와 실제 개인용 Work는 소유자 본인의 Z.AI Coding Plan `glm-5.2` 키로 실행합니다. 키는 로컬 소유자 전용 저장소에만 두고 renderer·로그·스크린샷·evidence·원격 Massion 서비스에 전달하지 않습니다. 계정·할당량을 다른 사용자에게 공유·대여·판매·중계하는 경로가 없는지 확인합니다.

- [ ] **Step 9: 재발 방지 릴리스 자동화를 연결합니다.**

`desktop-release.yml`은 수동 승인된 후보 SHA에서만 실행하고, 서명·공증 secret이 없으면 게시하지 않습니다. `verify-desktop-release.mjs`는 앱 버전·후보 SHA·서명·공증·sidecar·UAT evidence의 일치를 한 번만 검사합니다. GitHub Release는 모든 게이트가 같은 SHA로 통과한 뒤 마지막 단계에서만 생성합니다.

- [ ] **Step 10: 문서 주장을 실제 SHA와 결과로 갱신합니다.**

건너뛴 시나리오는 통과로 기록하지 않고 이유와 차단 조건을 씁니다.

- [ ] **Step 11: 증거 커밋을 만듭니다.**

```sh
git add docs/evidence/phase-30/desktop-live-uat-2026-07-24.md docs/evidence/phase-30/personal-desktop-release-YYYY-MM-DD.md PRODUCT.md docs/product/constitution.md docs/generated/requirements-traceability.tsv
git commit -m "test(desktop): 실제 AgentOS 사용자 시나리오 검증" \
  -m "Tauri 앱에서 Core·협업·조직·개선·확장·설정 시나리오와 재시작 지속성을 같은 릴리스 후보로 검증했습니다."
```

## 3. 계획 자체 검토

- 모든 사용자 요구는 Task 2~11에 연결돼 있습니다.
- 파일 첨부는 workspace 내부 참조로 범위를 고정해 새 업로드 저장소를 만들지 않습니다.
- 개발·테스트 패치와 개인용 도그푸딩에는 소유자 본인의 Coding Plan `glm-5.2`를 사용하고 BYOK 비공유 경계를 확인합니다.
- 과도한 unit test를 피하고 신뢰 경계와 실제 실패만 테스트합니다.
- 실제 앱 검증은 jsdom/브라우저가 아니라 빌드된 Tauri 앱과 Computer Use를 사용합니다.
- 완료 판정은 테스트 개수가 아니라 12개 핵심 시나리오와 구현된 확장 시나리오의 전부 통과입니다.
- 릴리스 판정은 서명·공증, 깨끗한 설치·업데이트·제거와 데이터 지속성, 비정상 종료, 키보드·VoiceOver, 개인 BYOK 격리까지 모두 같은 후보 SHA로 통과해야 합니다.
