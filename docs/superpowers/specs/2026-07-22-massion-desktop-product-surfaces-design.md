# Massion 데스크톱 제품 표면 구현 설계

> **상태:** 시각 방향 승인, 구현 전 설계 고정
> **기준일:** 2026-07-22
> **제품 기준:** [Massion 제품 헌법](../../product/constitution.md)
> **아키텍처 기준:** [독립 AgentOS 데스크톱 ADR](../../architecture/desktop-clean-sheet.md)

## 1. 결정 요약

Massion 데스크톱은 승인된 어두운 운영 콘솔 시각 언어를 유지하면서, 다음 일곱 표면을 하나의 공통 셸에서 독립적으로 제공합니다.

1. 대표·홈
2. 업무
3. 조직
4. 결정
5. 성장
6. 역량
7. 설정

설정은 역량이나 결정 화면에 섞지 않습니다. Provider, 계정 인증, 모델 경로, 실행 정책과 로컬 운영 환경은 별도 설정 표면에서 다룹니다. 역량 표면의 Extension은 읽기 전용 설치 목록이 아니라 검색, 검토, 승인, 설치, 업데이트와 되돌리기가 가능한 제품 흐름으로 구현합니다.

shadcn/ui는 소수의 팝업 부품만 가져오는 수준이 아니라 공통 셸과 반복 상호작용의 기본 재료로 적극 사용합니다. 다만 도메인 모델, 상태 판정과 화면 정보 구조는 Massion이 소유합니다. 기존 Work/Application 계약은 유지하고 표현 계층만 shadcn 구성요소로 재구성합니다.

## 2. 근거가 된 현재 상태

### 2.1 데스크톱

- `apps/desktop/src/app.tsx` 한 파일이 전역 레일, Work 화면과 임시 제품 표면을 함께 소유합니다.
- 대표와 업무 메뉴는 같은 Work 표면을 가리키며 대표·홈은 독립 표면이 아닙니다.
- 조직은 조회, 결정은 대기 승인, 자동화는 자율성 토글, 확장은 설치 목록 조회에 머뭅니다.
- `DesktopService`는 Work, 승인, 조직, 자율성, Extension 목록만 소비하며 Provider·계정·Registry 설치 계약을 소비하지 않습니다.

### 2.2 shadcn/ui

- Desktop은 React 19, Tailwind CSS 4, Base UI, Pretendard, Geist Mono와 Phosphor Icons를 이미 사용합니다.
- 현재 소유한 UI 소스는 Button, Badge, Avatar, Tabs, Tooltip, Dialog, Textarea와 Skeleton입니다.
- 현재 `components.json`은 구형 `new-york` 스타일과 별도 `base: base-ui` 필드를 섞어 최신 CLI 검증에 실패합니다. 공식 현재 스키마는 Base UI 계열을 `base-*` 스타일로 표현합니다.
- 기존 컴포넌트와 테마가 이미 사용자 작업 트리에 있으므로 `init --force`나 일괄 덮어쓰기는 금지합니다.

### 2.3 Provider와 인증

서버에는 다음 Application 계약과 생산 조립이 존재합니다.

- Provider, endpoint, credential, model, route, candidate 등록·조회
- 구독 Provider directory, 계정, quota, policy와 doctor 조회
- connector 등록·해제, server model 연결, 계정 등록·공유·해제·연결 끊기
- credential secret의 암호화 저장과 조회 응답에서의 비밀정보 제거

따라서 설정 화면을 위해 새 Provider 도메인을 만들지 않습니다. Desktop 투영과 누락된 연결 UX만 추가합니다.

### 2.4 Extension과 Registry

Extension Host에는 archive 검사, 권한 승인, worker 격리, 활성 세대, install/update/rollback이 구현되어 있습니다. Registry에도 search/info/inventory/install 계약과 설치 전 digest·manifest 재검증이 구현되어 있습니다.

그러나 운영 서버는 Store schema만 생성하고 다음을 Application Product에 주입하지 않습니다.

- Extension lifecycle과 worker supervisor
- Extension gateway와 artifact gateway
- Registry installer와 application adapter
- Extension/Registry command와 query의 실제 생산 구현

또한 안전한 disable/remove 수명주기는 아직 없습니다. DB 상태만 변경하면 worker, session, grant, contribution ownership과 감사 기록이 남으므로 UI에서 먼저 가짜 비활성화·삭제 버튼을 제공하지 않습니다.

## 3. 정보 구조

### 3.1 전역 이동

```text
Massion
├─ 대표·홈       조직에 사명을 맡기고 중요한 상황 파악
├─ 업무           Work 목록, 활동, 실행, 산출물, 검증
├─ 조직           부서·팀·에이전트·책임·편성 변경
├─ 결정           실행·권한·조직·성장 변경 승인
├─ 성장           개선 후보·근거·효과·되돌리기
├─ 역량           Skill·Tool·MCP·Extension 능력과 설치
└─ 설정           Provider·인증·모델 경로·운영 환경·정책
```

설정은 새 제품 도메인이 아니라 여러 도메인의 운영 구성을 한곳에 투영하는 표면입니다. Provider와 모델 경로는 조직이 일을 실행하기 위한 기반이므로 설정에 둡니다. Extension이 실제로 제공하는 Skill·Tool·MCP·조직 템플릿은 역량에 둡니다.

### 3.2 공통 셸

모든 표면은 다음 뼈대를 공유합니다.

```text
┌──────────────┬──────────────────────────────────────────────┐
│ App Sidebar  │ Desktop Header                               │
│              ├──────────────────────────────────────────────┤
│ 대표·홈      │ Surface Workspace                            │
│ 업무         │ 표면별 보조 목록 + 본문 + 선택적 Inspector  │
│ 조직         │                                              │
│ 결정         │                                              │
│ 성장         │                                              │
│ 역량         │                                              │
│              │                                              │
│ 설정         │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

- 전역 Sidebar는 `collapsible="icon"`으로 확장/축소합니다.
- Header는 현재 표면 제목, 연결 상태, Provider 제한 상태와 전역 명령 열기를 제공합니다.
- 각 표면은 같은 열 비율을 강제하지 않습니다. 필요한 경우에만 `ResizablePanelGroup`으로 보조 목록·본문·Inspector를 구성합니다.
- 최소 창 크기는 기존 1180×720px를 유지합니다. 이 크기에서는 전역 Sidebar가 아이콘 모드가 되고 Inspector는 접을 수 있습니다.
- 선택한 표면, Sidebar 상태와 표면별 패널 비율만 로컬 UI 환경설정으로 보존합니다. Work·승인·조직 같은 도메인 상태는 로컬 UI 저장소에 복제하지 않습니다.
- 첫 구현은 URL 라우터를 추가하지 않고 `SurfaceId` 상태로 전환합니다. 딥 링크나 브라우저 히스토리가 제품 요구가 될 때 라우터를 도입합니다.

### 3.3 표면별 레이아웃

| 표면 | 기본 패널 | 첫 번째 완료 행동 |
|---|---|---|
| 대표·홈 | 최근 사명 / Representative 대화 / 조직 브리핑 | 새 Mission을 영속 Work로 접수 |
| 업무 | Work 목록 / 활동·지시 / 작업·담당·검증 Inspector | 기존 Work 세로 흐름 보존 |
| 조직 | 조직 탐색 / 관계와 현재 배치 / 구성원·변경 Inspector | 부족 역량에서 새 팀 제안·승인·적용 |
| 결정 | 결정 큐 / 근거와 영향 / 계보·정책 Inspector | 승인·거부 후 원래 Work 또는 변경으로 복귀 |
| 성장 | 제안 목록 / 근거·diff·효과 / 채택 이력 | 개선 채택 후 다음 실행 효과와 Revert 확인 |
| 역량 | 분류·검색 / 능력·설치 목록 / 권한·기여 Inspector | Registry Extension 설치 후 Capability 제공 확인 |
| 설정 | 설정 분류 / 설정 양식 | Provider 인증과 모델 경로의 건강 상태 확인 |

## 4. shadcn/ui 적용 결정

### 4.1 공통 셸과 레이아웃

| 필요 | shadcn 소스 | 적용 위치 |
|---|---|---|
| 전역 이동 | Sidebar | AppSidebar, footer의 설정·사용자 상태 |
| 가변 작업 공간 | Resizable | Work, 조직, 결정, 성장, 역량의 패널 |
| 독립 스크롤 | ScrollArea | 긴 목록, 활동, Inspector |
| 전역 명령 | Command + Dialog | 표면 이동, 새 Work, 검색 |
| 구획 | Separator | Sidebar group과 Inspector section |
| 좁은 폭 보조 패널 | Sheet | 최소 폭에서 접힌 Inspector를 열 때만 |

### 4.2 내용과 상태

| 필요 | shadcn 소스 | 규칙 |
|---|---|---|
| 목록 행 | Item 또는 Table | 행 전체가 선택 대상이면 Item, 열 비교가 핵심이면 Table |
| 상태 | Badge, Progress | 상태 색은 제품 의미 토큰 사용 |
| 탭 | Tabs | 같은 객체의 보기 전환에만 사용 |
| 접기 | Accordion | 권한·근거 묶음처럼 계층이 있을 때만 사용 |
| 빈 상태·로딩 | Empty, Skeleton | 임시 카드나 가짜 fixture를 대신함 |
| 오류 | Alert | 사용자가 취할 복구 행동을 함께 표시 |
| 완료 알림 | Sonner | 명령 성공·실패의 짧은 피드백만 담당 |

### 4.3 입력과 거버넌스

| 필요 | shadcn 소스 | 적용 위치 |
|---|---|---|
| 설정 양식 | Field, Input, Select, Switch | label·설명·오류를 한 계약으로 구성 |
| 짧은 선택 | DropdownMenu, Popover | 필터와 행 보조 행동 |
| 정보 입력 | Dialog | Provider 연결, 새 팀 제안 |
| 위험·권한 행동 | AlertDialog | 승인 거부, 연결 해제, Extension 업데이트·되돌리기 |

Card는 화면 전체를 카드 격자로 만드는 데 사용하지 않습니다. 독립적인 요약 또는 경계가 실제로 필요한 단위에만 사용합니다. 기존 amber 한 가지 강조색, 암갈색 배경, 작은 radius와 제한된 border 계층을 유지합니다.

### 4.4 CLI 구성 복구

1. 현재 UI 소스와 `styles.css`를 기준선으로 보존합니다.
2. `components.json`을 최신 스키마의 Base UI 스타일로 변경합니다. 기존 Base UI와 가장 가까운 `base-nova`를 첫 후보로 사용하되 dry-run diff로 확인합니다.
3. `pnpm dlx shadcn@latest info`가 통과해야 다음 단계로 갑니다.
4. 필요한 구성요소만 `add`하고 `--overwrite`와 `--all`은 사용하지 않습니다.
5. 생성 코드가 Lucide를 추가하면 Phosphor로 치환하고 불필요한 아이콘 의존성을 남기지 않습니다.
6. 생성된 semantic token을 기존 제품 token에 매핑하고 `styles.css` 전체를 교체하지 않습니다.

## 5. 설정 표면

### 5.1 분류

| 분류 | 내용 | 초기 릴리스 |
|---|---|---|
| 일반 | 언어, 외관, 시작 동작 | 외관·시작 동작만 |
| Provider 및 계정 | API Provider, endpoint, credential, 구독 계정, 연결 상태 | 필수 |
| 모델 및 경로 | model profile, route, candidate, fallback, 진단 | 필수 |
| 권한 및 자동화 | Work 실행 자율성, Extension/Growth 승인 정책 | 기존 자율성 + 읽기 가능한 정책 |
| 저장 및 백업 | 로컬 데이터 위치, 백업·복구 | 현재 지원 계약만 노출 |
| 알림 | 승인·차단·완료 알림 | Desktop 알림 계약 이후 |
| 고급 | 버전, 진단, bridge/daemon 상태 | 필수 읽기, 제한된 복구 행동 |

지원되지 않는 분류는 동작하지 않는 토글로 미리 그리지 않습니다.

### 5.2 Provider 연결 흐름

```text
Provider 선택
→ 연결 방식 확인(API credential / 공식 connector / local endpoint)
→ 사용자 입력
→ Application command 제출
→ 비밀정보 form state 즉시 제거
→ catalog·account·doctor 재조회
→ 모델 경로 후보 연결
→ route 진단
→ ready 또는 limited 상태 표시
```

#### API credential

- `router.provider.register`, `router.endpoint.register`, `router.credential.add`를 사용합니다.
- secret은 password input의 일시적 React 상태에만 두고 localStorage, 로그, 오류, fixture와 query cache에 넣지 않습니다.
- 제출 직후 성공·실패와 관계없이 입력 상태를 지웁니다.
- 이후 조회는 secret을 반환하지 않는 `router.credentials`를 사용합니다.
- 현재 `router.credential.disable`은 실제 의미가 revoke이므로 UI 문구를 “폐기”로 표시합니다.

#### 공식 구독 connector

- `subscription.providers`로 지원 Provider와 연결 방법을 표시합니다.
- connector enrollment/server prepare/account register 계약을 연결합니다.
- `subscription.accounts`, `subscription.quota`, `subscription.doctor`로 재인증, 재연결, quota reset과 제한 상태를 표시합니다.
- 공유와 연결 해제는 기존 승인·권한 계약을 그대로 통과합니다.
- 비공식 cookie/token 자동화는 제공하지 않습니다.

#### 로컬 endpoint

- endpoint를 `local`로 등록하고 모델 profile과 route candidate를 연결합니다.
- 연결 여부와 모델 가용성은 저장 성공이 아니라 route 진단 결과로 판정합니다.

### 5.3 화면 상태

- `ready`: 연결과 필수 경로 진단 통과
- `limited`: 일부 핵심 모델 경로가 없거나 후보가 소진됨
- `needs-attention`: 재인증, connector 오류 또는 quota 소진
- `disconnected`: 사용자가 연결 해제

Header에는 전체 상태만 표시하고, 상세 원인과 해결 행동은 설정에서 제공합니다. Provider 장애가 있어도 Work 조회·결정·복구 같은 로컬 제어 기능은 계속 접근 가능해야 합니다.

## 6. 역량과 Extension 설치

### 6.1 화면 구조

역량 표면은 세 보기로 구성합니다.

- **역량:** 조직이 실제 사용할 수 있는 Skill·Tool·MCP·조직 템플릿
- **설치됨:** 설치 버전, 상태, 기여, 권한, 건강 상태와 되돌리기
- **찾기:** Registry 검색과 설치 후보 검토

패키지명보다 “무엇을 할 수 있게 되었는가”를 먼저 표시하고, Extension은 그 능력의 출처로 표시합니다.

### 6.2 Registry 설치 흐름

```text
registry.search
→ registry.info
→ 호환성·신뢰·기여·권한 검토
→ registry.install
→ 필요 시 awaiting-approval
→ 결정 표면에서 승인
→ 같은 command를 approval id로 재개
→ digest·manifest 재검증
→ worker 격리 시작과 generation 활성화
→ extension.list + registry.inventory 재조회
→ 제공 Capability를 Agent Runtime에서 확인
```

- 설치 버튼은 owner/admin에게만 표시합니다.
- 요청 권한, 새 Capability, publisher 신뢰와 recall 상태를 확인하기 전 설치하지 않습니다.
- 권한 증가 업데이트는 기존 `extension.permission_increase` 거버넌스를 우회하지 않습니다.
- 설치 중 승인 대기는 실패가 아니라 `awaiting-approval` 상태입니다. 결정 화면으로 이동할 수 있고 승인 후 동일 설치 흐름을 재개합니다.
- Registry recall은 설치된 역량에 경고를 표시하고 실행 제한·복구 행동으로 이어져야 합니다.

### 6.3 로컬 Extension

개발자용 로컬 패키지는 일반 Registry 설치와 분리합니다.

- 폴더 검증: `extension.validate`
- 개발 연결: `extension.link`
- archive 생성: `extension.pack`
- archive 설치·업데이트: `extension.install`, `extension.update`
- 과거 활성 버전 복구: `extension.rollback`

렌더러에 범용 filesystem 권한을 열지 않습니다. 폴더·파일 선택이 필요하면 Tauri의 전용 명령으로 선택 결과를 검증해 bridge에 전달합니다.

### 6.4 비활성화와 제거

현재 lifecycle에는 disable/remove 원자 명령이 없으므로 별도 세로 작업으로 구현합니다.

```text
행동 요청
→ 영향 Capability와 사용 중 Work 확인
→ 필요한 승인
→ worker 종료
→ session·grant·contribution ownership 정리
→ installation state·generation 원자 갱신
→ Audit/Event 기록
→ Agent Runtime에서 Capability 제거 확인
```

이 계약이 구현되기 전 UI는 disable/remove를 제공하지 않습니다. 구현 후에도 과거 Work의 provenance와 artifact는 삭제하지 않습니다.

## 7. Application·Desktop 계약

### 7.1 생산 서버 조립

`apps/server/src/product.ts`에서 같은 Store와 Artifact 기반으로 다음 인스턴스를 한 번만 조립합니다.

```text
ExtensionStore
+ FileArtifactStore
+ ExtensionWorkerSupervisor
+ GovernanceExtensionAuthorizer
→ ExtensionLifecycleService
→ ExtensionPackageService
→ ExtensionGateway
→ Application domain.extension / queries.extension / artifacts

RegistryCatalog
+ RegistryInstaller(위 lifecycle과 artifact 사용)
→ RegistryApplicationAdapter
→ Application registry operations
```

HTTP artifact 설치와 Registry 설치가 서로 다른 lifecycle을 만들지 않도록 합니다. 모든 설치 경로가 같은 권한 승인, archive 검사, worker 격리와 activation generation을 사용해야 합니다.

### 7.2 Desktop service

기존 `DesktopService`를 버리지 않고 다음 의미별 메서드를 추가합니다.

- 설정 조회: provider catalog, credentials, routes, subscription directory/accounts/quota/policy/doctor
- 설정 명령: provider/endpoint/credential/model/route/candidate, connector/account/policy
- Registry 조회: search, info, inventory
- Extension 명령: registry install, local install/update/rollback
- 성장과 조직 표면에 필요한 기존 Application query/command 투영

렌더러 컴포넌트는 operation 문자열을 직접 만들지 않습니다. Desktop service가 Application DTO를 화면용 view model로 투영하고 revision, awaiting-approval과 제한 상태를 보존합니다.

### 7.3 명령 상태

모든 변경 행동은 다음 공통 상태를 사용합니다.

- `idle`
- `submitting`
- `awaiting-approval`
- `succeeded`
- `failed`
- `conflicted` — revision 충돌 후 재조회 필요

낙관적으로 도메인 상태를 확정하지 않습니다. 명령 성공 뒤 관련 query를 다시 읽고 화면을 갱신합니다.

## 8. 렌더러 구조

첫 분리는 다음 정도로 제한합니다.

```text
apps/desktop/src/
├─ app.tsx                         # bootstrap과 최상위 상태
├─ shell/
│  ├─ desktop-shell.tsx
│  ├─ app-sidebar.tsx
│  ├─ desktop-header.tsx
│  └─ command-menu.tsx
├─ surfaces/
│  ├─ representative/
│  ├─ work/
│  ├─ organization/
│  ├─ decisions/
│  ├─ growth/
│  ├─ capabilities/
│  └─ settings/
├─ components/ui/                 # 소유하는 shadcn 소스
├─ desktop-service.ts             # Application 계약과 화면 투영
└─ styles.css                     # 제품 semantic token
```

각 표면은 초기에 `*-surface.tsx` 한 파일과 필요한 작은 하위 컴포넌트만 둡니다. 재사용 사례가 생기기 전에 generic panel/card abstraction을 만들지 않습니다.

## 9. 토큰과 시각 규칙

- 배경: canvas, chrome, surface 1, surface 2의 네 단계만 사용
- 텍스트: primary, secondary, muted의 세 단계
- 강조: amber 한 가지를 선택·주요 행동에 사용
- 상태: success, warning, danger, info는 상태 의미에만 사용
- 테두리: 기본 border와 interactive control 두 단계
- radius: 4/6/8px 계층 유지
- 글꼴: 본문 Pretendard, 식별자·버전·시간 Geist Mono
- 움직임: 120~180ms, 패널 resize와 상태 변화 중심; 장식 애니메이션 없음

shadcn의 `background`, `foreground`, `card`, `popover`, `primary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `sidebar-*` 토큰을 위 제품 토큰에 매핑합니다. 기존 클래스와 새 구성요소가 한 화면에서 다른 색 체계를 만들지 않도록 합니다.

## 10. 접근성·보안·오류

- Sidebar, Dialog, AlertDialog, Command, Field와 Resizable의 키보드 상호작용을 유지합니다.
- 아이콘 전용 버튼에는 접근 가능한 이름을 제공합니다.
- 색만으로 상태를 구분하지 않고 텍스트·아이콘·상태명을 함께 표시합니다.
- secret, token, raw header와 stack trace는 UI 오류에 포함하지 않습니다.
- 승인·권한·제거 행동은 이유와 영향을 표시하고 audit 가능한 Application command를 사용합니다.
- SSE 재연결 중에는 이전 데이터를 완료 상태로 오인하지 않고 stale 표시와 재조회 행동을 제공합니다.
- 전체 오류 화면 대신 표면별 오류 경계를 두어 Provider 장애가 다른 로컬 제어 표면을 막지 않게 합니다.

## 11. 구현 순서

### 단계 0 — 계약과 shadcn 기준선

- 최신 CLI에서 `components.json` 검증 복구
- 필요한 shadcn 소스만 추가
- Desktop surface/view model 계약 추가
- 현재 `app.tsx`에서 셸과 표면 경계 분리

완료 조건: 기존 Work 흐름이 같은 Application 계약으로 열리고, 공통 셸에서 일곱 표면으로 이동할 수 있습니다.

### 단계 1 — 공통 셸과 Work 이전

- Sidebar, Header, Command menu, Resizable workspace 구현
- 기존 Work 목록·활동·Inspector를 새 셸로 이동
- 표면별 패널 크기와 Sidebar 상태만 로컬 보존

완료 조건: Work 생성·선택·지시·승인·취소·재개가 회귀 없이 동작합니다.

### 단계 2 — 설정과 Provider 인증

- Provider/계정/모델 route view model과 설정 화면 구현
- API credential, 공식 connector와 로컬 endpoint 연결
- doctor와 route 진단을 Header의 ready/limited 상태에 연결

완료 조건: 사용자가 빈 설치에서 Provider 또는 로컬 endpoint를 연결하고 핵심 route가 ready인지 확인할 수 있습니다.

### 단계 3 — Extension 운영 조립과 Registry 설치

- Extension lifecycle·worker·gateway·artifact의 생산 조립
- Registry installer/application adapter의 생산 조립
- search/info/install/inventory Desktop 연결
- approval 대기와 재개 연결

완료 조건: Registry의 공식 Extension 하나가 권한 승인 후 활성화되고 실제 Capability가 조직에 제공됩니다.

### 단계 4 — 조직·결정·성장 세로 흐름

- 읽기 전용 임시 화면을 승인된 표면으로 교체
- 조직 부족 → 새 팀 제안 → 결정 → 적용 → Work 배정
- 완료 Work → 성장 제안 → 결정 → 다음 실행 효과 → Revert

완료 조건: 제품 헌법의 조직 운영 UAT 한 흐름이 데스크톱에서 닫힙니다.

### 단계 5 — Extension disable/remove와 운영 마감

- 안전한 deactivate/remove 도메인 계약과 cleanup 구현
- Desktop·CLI의 이미 광고된 누락 handler 연결
- 오류 복구, 재시작 복구, macOS arm64 패키징 확인

완료 조건: 설치·업데이트·되돌리기·비활성화·제거가 감사와 기존 Work provenance를 보존합니다.

## 12. 검증 범위

반복적인 전체 회귀 대신 변경 경계에 맞춥니다.

- UI 소스 추가: Desktop typecheck와 해당 component test
- 셸 변경: 이동·키보드·패널 상태 component test
- Provider 설정: Desktop service projection test + Application 계약 test
- Extension 조립: server product integration test + install/approval 한 세로 테스트
- disable/remove: lifecycle 원자성·worker cleanup·audit 집중 테스트
- 단계 완료 시에만 Desktop build와 관련 UAT 실행

변경되지 않은 Web/TUI 화면이나 무관한 패키지의 반복 리뷰는 이 작업의 기본 절차가 아닙니다.

## 13. 완료 정의

- 일곱 표면이 공통 셸에서 독립적으로 이동됩니다.
- 설정에서 Provider·인증·모델 경로를 구성하고 건강 상태를 확인할 수 있습니다.
- 역량에서 Registry Extension을 검토·승인·설치하고 실제 제공 Capability를 확인할 수 있습니다.
- 대표·홈과 Work는 같은 화면의 별칭이 아닙니다.
- 조직·결정·성장은 실제 Application 데이터와 변경 행동을 가집니다.
- shadcn은 공통 레이아웃과 접근성 상호작용을 담당하되 제품 정보 구조와 도메인 상태를 소유하지 않습니다.
- 독립 데스크톱 보안 경계와 로컬 우선 제어가 유지됩니다.

## 14. 외부 근거

확인일은 2026-07-22입니다.

- shadcn/ui [Sidebar](https://ui.shadcn.com/docs/components/base/sidebar)
- shadcn/ui [Resizable](https://ui.shadcn.com/docs/components/base/resizable)
- shadcn/ui [Field](https://ui.shadcn.com/docs/components/base/field)
- shadcn/ui [`components.json`](https://ui.shadcn.com/docs/components-json)
- shadcn/ui [Tailwind CSS v4](https://ui.shadcn.com/docs/tailwind-v4)
