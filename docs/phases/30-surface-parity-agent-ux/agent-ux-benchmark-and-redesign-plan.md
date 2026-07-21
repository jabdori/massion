# Phase 30 — 에이전틱 도구 UX 벤치마크와 TUI·Web 근본 재설계 계획

> **상태**: in-progress (2026-07-21 UX-0·UX-1·UX-2·WS-1·WS-2 및 Web workspace parity 구현 완료)
> **작성일**: 2026-07-21

## 진행 현황 (2026-07-21)

| 슬라이스 | 상태 | 근거 커밋 |
|---|---|---|
| UX-0 판정 2건 | 완료 | [판정 문서](ux0-spike-judgments.md) — `@opentui/solid` 채택, ExecutionDeltaPort 확정 |
| WS-1 Workspace 도메인 + Work 바인딩 | 완료 | `fe4f94e`, `c998c96` (migration 0106·0107) |
| WS-2 Application API + CLI/TUI cwd attach | 완료 | `3ece5f8`, `083aa55` (`--workspace`, g 키 스코프 전환) |
| UX-1 `work.timeline` 공통 투영 | 완료 | `209d7b1` + Web 진행 기록 표시. 팔레트 metadata는 UX-3 팔레트와 함께 |
| UX-2 실행 스트림 | 서버측 완료 | `c23738f` — delta observer·fan-out registry·`/api/v1/executions/stream`. Surface 소비는 UX-3·4에서 |
| Web workspace parity | 완료 | `2aa1c4c` — /workspaces 관리(등록·신뢰·보관)·작업 필터 |
| UX-3 TUI transcript 재설계 | 대부분 완료 | `9b9d4b9` transcript, `cd05ac1` Ctrl+P 팔레트, `b3dc0c4` **solid 렌더러 전환 완료** — 렌더 트리를 `@opentui/solid` 컴포넌트로 교체(로직·키 처리·테스트 의미 보존, 렌더러 parity 테스트 18건 무변경 통과), dist는 `Bun.build`+solid plugin 번들, tsc는 typecheck 전용. 주의: 이 reconciler(0.4.3)는 `Show keyed`에서도 renderable을 재사용하므로 input 초기화는 ref로 직접 수행. 스트리밍 active cell·상시 composer(`2f8e53a`)·승인 실행 미리보기 오버레이(`d9ce3ac`)까지 완료 — **UX-3 전체 완료** |
| UX-4 Web 관제 분할 화면·SSE | 완료 | 팔레트(`ffdbcbb`) + Work 상세 2단 분할·실행 델타 응답 중 셀(`5fddf4c`) + **사건 기반 무효화로 폴링 제거**(`92cf0ec` — Work 사건이 보유 중인 timeline·provenance를 다시 읽음) |
| UX-5 신뢰 장치 | 완료 | 신뢰 게이트(`65d4f7a`)·터미널 벨(`fdf2608`)·Git provenance(`ad23e65`) + **자율성 다이얼**(`821e6ae` — `@massion/governance` AutonomyStore migration 0108, review 모드가 읽기 외 allow를 승인 요구로 조이기 전용 승격, TUI 헤더·팔레트·Web AccessPage) |
| WS-4 Web 역할 결정 | 완료 | [ws4-web-role-decision.md](ws4-web-role-decision.md) — Web=GUI 동일 화면, browser.ts 계약 경계, 로컬 능력 어댑터, WS-3 spike 판정 기준 |
| WS-3 GUI shell | 완료 | `apps/desktop` Tauri shell(`dc87d4d`): 로컬 서버 콘솔을 native window로 로드, 미기동 시 `massion local start` 기동, `window.massionShell`로 폴더 선택·알림 주입. Rust 컴파일 47.8초·32MB 바이너리 성공. 번들 서명·배포는 릴리스 파이프라인 결정 시 연결 |
> **대상**: `apps/tui`, `apps/web`, `packages/application` (표현 계약 확장)
> **관계**: [Phase 30 design](design.md)의 REQ-SURFACE-004(공통 view-model·접근성)를 대체·확장하는 재설계 제안

## 1. 문제 판정

Massion TUI·Web은 기능 동등성(parity)은 진전됐지만, Codex CLI · Claude Code · OpenCode · Aider · Goose 등 현행 에이전틱 도구와 비교하면 **상호작용 모델 자체가 다른 세대**에 속합니다.

### 1.1 현재 구조의 근본 문제

| 항목 | Massion 현재 | 업계 표준 (2026) |
|---|---|---|
| 중심 화면 | 목록/상세 2패널 대시보드 (TUI), 리소스별 페이지 (Web) | **대화 transcript가 중심**, 상태는 주변부 |
| 실시간성 | `r` 수동 새로고침, mutate 후 명시적 refresh | 토큰 단위 스트리밍, 사건 기반 자동 갱신 |
| 에이전트 활동 가시성 | 상태 문자열만 표시 (`running`, `blocked`) | 도구 호출·실행 결과·추론이 **실행 셀**로 표시 |
| 승인 | 별도 화면에서 목록으로 확인 | 흐름 안에서 **차단형 오버레이 + 변경 diff** 제시 |
| 입력 | 모달 다이얼로그 (한 줄 입력) | 상시 표시되는 멀티라인 composer + slash 명령 |
| 산출물 확인 | ID·버전 숫자만 표시 | 색상 diff, 마크다운 렌더링, 파일 참조(@) |
| 계획 가시성 | 없음 | plan/todo 진행 표시, 완료 항목 체크 |

핵심 판정: **문제는 기능 부족이 아니라 표현 모델입니다.** Massion의 도메인(Work·사건 계보·승인·검증)은 경쟁 도구보다 오히려 풍부하지만, Surface가 그 계보를 "관리 화면"으로만 투영하고 "함께 일하는 경험"으로 투영하지 못합니다. 사용자는 에이전트가 *지금 무엇을 하고 있는지* 볼 수 없고, 개입 시점을 흐름 안에서 만나지 못합니다.

## 2. 벤치마크 조사 결과

### 2.1 Codex CLI (OpenAI, Rust + ratatui)

- **구조**: `ChatWidget`(스크롤 transcript) + Bottom Pane(composer + 오버레이 스택) + 상태 footer의 3층 구조.
- **HistoryCell 다형성**: 사용자 메시지·어시스턴트 마크다운·도구 실행·스트리밍 중인 active cell을 각각 다른 셀 타입으로 렌더링. 확정된 셀은 캐시하고 active cell 꼬리만 다시 그려 스트리밍 성능을 확보.
- **승인**: `ApprovalOverlay`가 bottom pane 스택에 떠서 명령·patch를 색상 diff로 보여주고 승인/거부/수정/전체 승인을 한 키로 처리. 승인 모드(Read-Only / Auto-Edit / Full-Auto)는 세션 중 전환 가능한 "안전 다이얼".
- **slash 명령**: `/model`, `/review`, `/mcp`, `/plan` 등 자동완성 포함.
- **교훈**: 스트리밍 transcript + 오버레이 스택 + 승인 다이얼이 TUI 에이전트 UX의 기준 골격.

### 2.2 Claude Code (Anthropic)

- **권한 모드 사이클**: Shift+Tab으로 normal → auto-accept → plan 모드 순환. Plan 모드는 읽기 전용 탐색 후 계획을 제시하고 승인받는 별도 상호작용 단계.
- **todo/plan 시각화**: 에이전트가 스스로 작업 목록을 만들고 진행하며 체크하는 것이 화면에 그대로 보임 — 긴 작업의 신뢰 확보 장치.
- **도구 호출 표시**: 각 도구 호출이 접을 수 있는 블록으로 표시되고, 위험 동작만 권한 프롬프트로 중단.
- **교훈**: "자율성 다이얼 + 계획 가시성 + 도구 호출 공개"의 결합이 긴 자율 실행의 신뢰를 만든다.

### 2.3 OpenCode (SST)

- **아키텍처가 Massion과 가장 유사**: 서버가 LLM 추론·도구 실행·세션 영속을 소유하고, TUI·데스크톱·웹·모바일이 **HTTP + SSE로 붙는 thin client**. TUI는 표현·입력·일시적 UI 상태만 가짐.
- **TUI 구현**: SolidJS + `@opentui/solid` (Massion과 같은 OpenTUI 계열이지만 반응형 컴포넌트 방식). SyncProvider(서버 동기화 상태) / LocalProvider(로컬 일시 상태) / ThemeProvider(테마) 3층 상태.
- **UX 장치**: `/sessions` 세션 전환, `/undo`·`/redo`(Git 기반 파일 변경 되돌리기), `@` 파일 fuzzy 참조, `!` 셸 실행, `/share` 세션 공유 링크, 20+ 테마, attention 알림(질문·승인·완료 시 데스크톱 알림·소리).
- **명령 팔레트**: `ctrl+p`(`command_list`)로 모든 명령·설정(세션 전환, 모델 선택, 테마, 표시 토글 등)을 fuzzy 검색 목록에서 실행. slash 명령을 외우지 않아도 기능을 발견할 수 있는 discoverability 장치.
- **교훈**: Massion과 같은 서버 중심 구조에서도 1급 대화형 TUI가 가능하다는 실증. 상태 3층 분리와 `@opentui/solid` 채택 경로가 직접 참고 대상.

### 2.4 Aider

- **repo map**: 저장소 전체의 구조적 지도를 만들어 컨텍스트로 사용 — 큰 저장소에서의 근거 확보 방식.
- **git 네이티브**: 모든 변경이 의미 있는 메시지의 커밋이 되고 `/undo`로 즉시 되돌림. 변경 이력 자체가 UI.
- **교훈**: "모든 변경은 되돌릴 수 있는 커밋"이라는 안심 장치. Massion의 `software-engineering` Git provenance와 정합적이며, Surface에 노출만 하면 됨.

### 2.5 Goose (Block)

- **CLI + 데스크톱 앱 이중 Surface**, MCP 확장 70+개 생태계. 실행 전 아키텍처·배포 대상을 묻고 구조화된 계획을 만드는 계획 우선 상호작용.
- **교훈**: 확장(Extension) 생태계를 Surface에서 발견·설치·권한 부여하는 UX. Massion Registry·capability broker와 맞닿음.

### 2.6 Web 에이전트 콘솔 (OpenHands · Devin 계열)

- OpenHands Agent Canvas: 대화 시작·작업 자동화의 **관제 센터(control center)**. 계획·실행·검토를 한 화면에서 협업형으로 진행, 여러 백엔드 환경을 같은 프론트에서 전환.
- Devin 계열: 좌측 대화 + 우측 작업 공간(터미널·브라우저·에디터 미리보기)의 분할 화면, 계획 단계 승인, 타임라인 스크럽.
- **교훈**: Web은 TUI의 복제가 아니라 **관찰·검토·병렬 관리에 강한 관제 화면**이어야 함. 대화 + 실행 타임라인 + 산출물 검토의 3요소.

### 2.7 에이전트 UX 일반 원칙 (2026 업계 정리)

생존한 패턴 5가지: ① 계획 가시성(planning visibility) ② 도구 사용 공개(tool-use disclosure) ③ 다단계 진행 추적 ④ 중단·취소 가능성 ⑤ 실패 복구 경로 제시. 자율성은 Suggest / Co-pilot / Autopilot 3모드로 조절 가능해야 하며, **인터페이스가 곧 책임(accountability) 계층**이라는 관점이 공통 결론.

## 3. 갭 분석 — Massion 아키텍처 관점

Massion의 백엔드 계보는 이 패턴들을 담기에 이미 충분히 풍부합니다. 갭은 세 곳에 있습니다.

### 3.1 스트리밍 세밀도 (Application API)

현재 공개 event는 도메인 사건 단위(Work 상태 전이, 메시지 생성)입니다. 경쟁 도구의 체감 품질을 만드는 것은 **토큰·도구 호출 단위의 실행 스트림**입니다. Runtime(VoltAgent adapter)은 이미 스트리밍을 다루지만 Surface까지 전달되지 않습니다.

- 필요: `RuntimeExecution`의 실행 델타(모델 출력 chunk, 도구 호출 시작/종료, 도구 결과 요약)를 공개 event로 투영하는 **execution stream channel**. 기존 SSE·cursor 규약을 재사용하되, 재연결 replay는 요약본으로 대체 가능(토큰 델타는 durable할 필요 없음 — 확정 메시지가 정본).

### 3.2 통합 타임라인 투영 (공통 view-model)

Work의 계보(Request → Context → Evidence → Delivery → Approval → Runtime → Assurance → Records)가 별개 query로 흩어져 있어 Surface마다 재조합합니다.

- 필요: **`work.timeline` 공통 투영** — 하나의 Work에 대해 시간순 정렬된 이질적 항목(사용자 메시지, 에이전트 메시지, 도구 실행, 승인 요청, 검증 결과, 산출물 버전)을 단일 리스트로 반환. Codex의 HistoryCell 다형성에 해당하는 서버측 정본. Phase 30의 capability 계약 원칙("기능 목록은 화면 코드가 아니라 공통 계약이 정본")과 정확히 일치.

### 3.3 표현 계층 구조 (TUI·Web)

- TUI: 명령형 OpenTUI 코드(`open-tui.ts` 787줄 단일 클래스)가 목록/상세/모달을 직접 조립. transcript·스트리밍·오버레이 스택 구조가 없음.
- Web: 페이지-리소스 1:1 대시보드. Work 상세조차 카드 나열이고, 실시간 갱신·diff·마크다운 렌더링 없음.

## 4. 재설계 방향

### 4.1 제품 원칙 (기존 8원칙에 추가)

9. **대화가 기본 화면입니다.** 사용자는 Work를 "관리"하기 전에 "대화"합니다. 목록·지표는 보조 화면입니다.
10. **에이전트 활동은 실시간으로 공개합니다.** 도구 호출·계획 진행·모델 시도는 발생 즉시 transcript에 나타납니다.
11. **개입은 흐름 안에서 만납니다.** 승인·질문·차단은 별도 화면 이동 없이 현재 대화 위 오버레이(TUI)·인라인 카드(Web)로 제시하고, 변경 내용(diff)을 함께 보여줍니다.
12. **자율성은 다이얼입니다.** Governance의 auto/review 정책을 사용자가 세션 중 전환할 수 있는 모드로 노출합니다 (조직 정책이 허용하는 범위 내).
13. **모든 기능은 팔레트에서 발견됩니다.** TUI `Ctrl+P` · Web `Cmd/Ctrl+K` 명령 팔레트가 capability 계약을 fuzzy 검색 목록으로 노출합니다. 팔레트 항목은 화면 코드가 아니라 capability 계약에서 생성하므로, 한쪽 Surface에서 기능이 누락되면 palette parity 테스트가 실패합니다.

### 4.2 목표 화면 구조

**TUI — conversation-first 3층 구조 (Codex 골격 + OpenCode 상태 모델)**

```text
┌──────────────────────────────────────────────┐
│ header: 조직·Work·연결 상태·자율성 모드        │
│                                              │
│ transcript (스크롤)                           │
│   ● 사용자 메시지                             │
│   ● 에이전트 응답 (마크다운, 스트리밍)         │
│   ▸ 도구 실행 셀 (접기/펼치기)                │
│   ▸ 승인 요청 셀 → 오버레이                   │
│   ✓ 검증·산출물 셀 (diff 요약)                │
│                                              │
│ [오버레이 스택: 승인 diff / 목록 선택 / 도움말] │
│ composer: 멀티라인 입력, / 명령, @ 참조        │
│ footer: 진행 spinner·단계·비용·키 힌트         │
└──────────────────────────────────────────────┘
```

Work 목록·승인 목록·운영 화면은 slash 명령(`/works`, `/approvals`, `/ops`)으로 여는 전환 화면 또는 오버레이로 강등합니다.

**Web — 관제 센터 (OpenHands Canvas 참조)**

- Work 상세 = 좌측 대화 transcript(스트리밍) + 우측 실행 패널(계획 진행, 작업·배정, 산출물 diff, 검증 결과) 분할 화면.
- 홈 = 진행 중인 Work 카드가 **라이브 상태**(현재 단계·최근 활동 한 줄)로 갱신되는 관제 보드.
- 승인 = 전용 페이지는 유지하되, Work 대화 안에도 인라인 승인 카드를 제시.

### 4.3 아키텍처 적용 방식

| 계층 | 변경 | 소유 위치 |
|---|---|---|
| Runtime | 실행 델타(출력 chunk·도구 수명주기)를 outbox 밖의 휘발성 스트림으로 발행 | `packages/runtime` |
| Application | `work.timeline` query + execution stream SSE channel + timeline 항목 view-model(셀 타입 union) | `packages/application` |
| 공통 표현 | 셀 타입별 표시 계약(이름·아이콘·상태 용어·접근성 라벨)을 capability 계약에 추가 — TUI·Web 공유 | `packages/application` |
| TUI | `@opentui/core` 명령형 조립 → `@opentui/solid`(또는 react) 컴포넌트 구조로 전환, transcript·composer·오버레이 스택 도입 | `apps/tui` |
| Web | Work 상세를 분할 화면으로 재구성, SSE 구독으로 폴링 제거, 마크다운·diff 렌더러 도입 | `apps/web` |
| Governance | 자율성 다이얼(세션 승인 모드 전환) command — 조직 정책 상한 내에서만 | `packages/governance`, `packages/application` |

경계 유지: 토큰 델타는 도메인 정본이 아니므로 SurrealDB에 기록하지 않고, 확정 메시지·사건만 기존 transaction 경로를 탑니다. 기존 사건·cursor replay 규약은 변경하지 않습니다.

## 5. 실행 계획 (수직 슬라이스)

각 슬라이스는 실패 테스트 → 최소 구현 → focused test 순서로 진행하고, TUI·Web 동시 검증을 완료 조건으로 합니다.

### Slice UX-1: `work.timeline` 공통 투영 (기반)

- [ ] timeline 항목 union 타입(메시지·도구 실행·승인·검증·산출물)과 정렬·페이지 규약 정의
- [ ] 기존 도메인 query 조합으로 `work.timeline` 구현 + 계약 테스트
- [ ] 셀 타입별 표시 계약(용어·상태 토큰·접근성 의미)을 capability 계약에 추가
- [ ] capability 계약에 팔레트 metadata 추가: 표시 이름·검색 키워드·분류(이동/명령/설정)·위험 여부·현재 상태에서의 사용 가능 조건 — TUI `Ctrl+P` · Web `Cmd/Ctrl+K`의 공통 소스

### Slice UX-2: 실행 스트림

- [ ] Runtime 실행 델타 발행 port 정의 (`packages/runtime`)
- [ ] Application SSE channel(`execution.stream`)과 재연결 시 요약 fallback
- [ ] blocked·취소·lease 회수 시 스트림 종료 의미 고정 (기존 상태 기계와 정합)

### Slice UX-3: TUI transcript 재설계

- [ ] `@opentui/solid` 도입 평가 (Bun 호환·기존 `open-tui.bun.test.ts` 이전 비용) — 불가 시 현행 core 위에 셀 렌더러 직접 구현
- [ ] transcript + 스트리밍 active cell + composer + 오버레이 스택
- [ ] slash 명령·자동완성, 기존 화면들을 `/works` 등 전환 화면으로 이전
- [ ] `Ctrl+P` 명령 팔레트 오버레이: capability 계약에서 항목 생성(이름·설명·키 힌트·위험 표시), fuzzy 검색, 설정성 항목(테마·자율성 모드·알림·Provider 온보딩) 포함
- [ ] 승인 오버레이: 대상·위험도·변경 diff·사유 입력을 한 화면에서 처리

### Slice UX-4: Web 관제 재설계

- [ ] Work 상세 분할 화면 (대화 + 실행 패널), SSE 구독으로 폴링 제거
- [ ] 마크다운·diff 렌더러, 계획 진행 시각화
- [ ] 인라인 승인 카드, 라이브 관제 홈
- [ ] `Cmd/Ctrl+K` 명령 팔레트: TUI와 같은 capability 계약 소스에서 항목 생성, 페이지 이동·명령 실행·설정 통합

### Slice UX-5: 신뢰 장치

- [ ] 자율성 다이얼 (정책 상한 내 세션 모드 전환)
- [ ] attention 알림 (질문·승인·완료 시 — TUI 터미널 벨·Web 알림)
- [ ] Git provenance Surface 노출 (변경 커밋·되돌리기 진입점, `software-engineering` 계보 재사용)

### 검증

- [ ] 동일 fixture에서 TUI·Web timeline 셀 순서·용어·상태 일치 (REQ-SURFACE-UAT-001 확장)
- [ ] palette parity: 두 Surface의 팔레트 항목 집합이 capability 계약과 일치 (누락 시 CI 실패)
- [ ] Provider 연결 상태에서 스트리밍 UAT: 델타 표시 → 확정 메시지 대체 → 재연결 replay
- [ ] 접근성: 스트리밍 중 스크린리더 announce 정책, NO_COLOR·80×24 유지

## 6. 워크스페이스 모델과 Surface 지형 (2026-07-21 추가 승인 범위)

### 6.1 문제 판정

현재 Massion에는 **사용자 수준 워크스페이스(디렉토리) 개념이 없습니다.** `workspace_id`는 `engineering_delivery` 내부(TDD 전달용 격리 Git workspace)에만 존재하고, Work 도메인은 디렉토리에 바인딩되지 않습니다. 사용자가 "이 프로젝트 디렉토리에서 일해줘"라고 지정할 방법과 도구가 없습니다.

업계 표준 (조사 결과):

| 도구 | 모델 |
|---|---|
| Codex | 4-Surface(CLI·Desktop·IDE·Cloud)가 App Server(JSON-RPC/JSONL) 하나로 통신. **CLI TUI는 현재 디렉토리 세션만**, Desktop(Electron)은 프로젝트 sidebar에 모든 워크스페이스·스레드·worktree를 보여주는 관제 센터. Cloud UI는 Desktop과 거의 동일 |
| Claude Code | CLI 세션은 `~/.claude/projects/<slug>/` 디렉토리 단위 저장·재개. Desktop(2026-04 재설계)은 멀티 세션 sidebar + 세션별 프로젝트 폴더 + Git worktree 격리 병렬 실행 |
| OpenCode | 서버 중심, `opencode`를 디렉토리에서 실행하면 그 디렉토리 컨텍스트로 TUI가 붙음 |

공통 패턴: **TUI = 디렉토리 스코프, GUI/데스크톱 = 전역 관제 센터, Web/Cloud UI ≈ GUI와 동일.** Massion은 이미 OpenCode형 서버 중심 구조이므로, 빠진 것은 서버가 아니라 **Workspace 도메인 개념과 Surface별 스코프 규칙**입니다.

### 6.2 목표 모델

**Workspace = tenant 소유의 등록된 디렉토리** (1급 도메인 개념, 신규 `@massion/workspace` 소유 제안)

- 필드: 경로, 이름, VCS 상태(git root·remote), 신뢰 상태(trusted 승인 전 도구 실행 차단), 마지막 사용 시각
- Work는 선택적 `workspaceId` 바인딩을 갖고, 비개발 Work는 워크스페이스 없이 존속 가능
- 기존 `engineering_delivery.workspace_id`(격리 실행 사본)와 구분: 사용자 Workspace가 원본, delivery workspace는 그 파생
- Evidence(RepositoryRevision)·software-engineering·runtime 도구의 경로 판정은 Workspace를 정본으로 참조

**Surface 지형과 스코프 규칙**

| Surface | 스코프 | 역할 |
|---|---|---|
| CLI/TUI (`massion`) | 실행 디렉토리의 Workspace로 자동 attach (`--dir` 지정 가능, 미등록이면 신뢰 확인 후 등록) | 그 워크스페이스의 Work·세션만 기본 표시, 팔레트에서 전역 전환 가능 |
| GUI (신규, native shell) | 전역 | 워크스페이스 sidebar + 병렬 Work 관제 센터. `apps/web` 코드를 native shell(Tauri 우선 검토)로 감싸고 폴더 선택·알림·tray 등 로컬 능력만 추가 |
| Web Console | 전역 (GUI와 동일 UI) | 같은 `apps/web` 코드. 로컬 서버 접속용 브라우저 화면이자 향후 원격/팀 접속 화면. GUI와 Web은 별도 제품이 아니라 같은 화면의 두 배포 형태 |

### 6.3 실행 슬라이스 (기존 UX 슬라이스와 병행 가능)

**Slice WS-1: Workspace 도메인 (기반, UX-1과 병렬 가능)**
- [ ] `@massion/workspace` 계약: 등록·신뢰·조회·삭제 command/query + tenant 격리 테스트
- [ ] Work에 선택적 `workspaceId` 바인딩과 스코프 query (`work.list`에 workspace filter)
- [ ] capability 계약에 워크스페이스 스코프 표시·전환 항목 추가

**Slice WS-2: CLI·TUI 디렉토리 attach**
- [ ] `massion` 실행 시 cwd → Workspace 판정(등록·신뢰 확인 흐름), `--dir` 옵션
- [ ] TUI 헤더에 현재 워크스페이스 표시, 기본 목록을 워크스페이스 스코프로 전환
- [ ] 팔레트에 "워크스페이스 전환 / 전체 보기" 항목

**Slice WS-3: GUI shell (UX-4 완료 후)**
- [ ] Tauri(우선)·Electron 비교 spike: `apps/web` 재사용 + 폴더 선택 dialog + 알림
- [ ] 워크스페이스 sidebar(모든 워크스페이스·Work·세션)와 병렬 관제 레이아웃
- [ ] 로컬 서버 자동 기동·연결 (기존 `massion --web` 부트스트랩 재사용)

**Slice WS-4: Web 역할 정의 (연구 → 결정 문서)**
- [ ] 로컬 콘솔 vs 원격 팀 접속 vs 향후 Cloud의 경계·인증 차이 정리
- [ ] GUI와 Web의 코드 공유 경계(로컬 능력 어댑터 계층) 계약화

### 6.4 워크스페이스 관련 위험

| 위험 | 완화 |
|---|---|
| 경로가 도메인 정본에 들어가며 이식성·보안 문제 | 경로는 로컬 서버 기준으로만 유효함을 계약에 명시, 원격 배포에서는 workspace 종류를 분리(local-directory vs remote) |
| 신뢰되지 않은 디렉토리에서 도구 실행 | trusted 승인 전 실행 차단 (Claude Code trusted folder 패턴) |
| GUI 신규 앱의 유지 비용 | 화면 코드는 `apps/web` 단일 소스, shell은 얇은 wrapper로 한정 |

## 7. 위험과 결정 필요 사항

| 위험 | 완화 |
|---|---|
| `@opentui/solid` 전환 비용이 큼 | Slice UX-3에서 spike로 먼저 판정, 실패 시 현행 core 위 셀 렌더러로 한정 |
| 토큰 스트림이 사건 정본 규약을 오염 | 휘발성 채널로 분리, 확정 정본은 기존 경로 유지 (4.3 경계) |
| Phase 30 parity 작업과 범위 충돌 | UX-1(공통 투영)이 parity 계약의 상위 호환이므로 선행 — 화면 단위 parity 작업은 UX-3·4로 흡수 |
| 승인 diff에 필요한 산출물 내용 조회 API 부재 가능성 | UX-1에서 artifact 내용 조회 계약을 함께 판정 |

이 계획이 승인되면 Phase 30의 남은 화면 작업은 이 재설계 슬라이스로 대체·흡수하고, 요구사항 추적표에 REQ-SURFACE-UX 항목을 추가합니다.

## 8. nimbalyst 렌더러 이식 — 시각 품질 v1 (2026-07-21)

사용자 재지적("시각적으로 개선된 게 없다")에 대한 응답으로 nimbalyst 렌더러를 clone-and-own 으로 vendor 하고 WorkPage 에 적용했다.

| 범위 | 상태 | 근거 커밋 |
|---|---|---|
| nimbalyst 패키지 vendor (runtime·extension-sdk·collab-protocol·collab-adapters) | 완료 | `2ef2d5a` — MIT 출처 표기(`src/vendor/README.md`), tests 제외 반입 |
| 빌드 격리 (tailwind 3.4 + postcss + tsconfig.vendor.json + @nimbalyst alias) | 완료 | `2ef2d5a` — 메인 strict typecheck 보호, vendor 만 Bundler 해상도로 별도 검사 |
| crystal-dark 테마 + AIInput(composer) 적용 | 완료 | `4910482` — NimbalystTheme.css + crystal-dark 토큰, 앱 쉘 전체 다크 전환 |
| TranscriptItem 어댑터 (work.timeline + 실행 델타 → transcript) | 완료 | `4910482` — 단일 매핑 경계, Massion 도메인 정본 재사용 |
| WorkTranscript 렌더 검증 | 완료 | `f673b1c` — role/kind 셀·마크다운·streaming cell 테스트 |

v1 의도적 한계(다음 슬라이스): lexical 리치 편집·monaco·mermaid·칸반은 vendor 에 보존하고 lazy-load 전환 후 활성화(현재는 react-markdown 읽기 + nimbalyst AIInput). nimbalyst AgentTranscript(lexical 기반)는 barrel 이 무거운 체인(file-tree·lexical)을 끌어와 v1 미사용 — WorkComposer 는 AIInput 진입점을 직접 import 해 차단. collab(Yjs)/AI provider 백엔드는 로컬 단일 사용자 기준 드롭.

> **상태**: in-progress (2026-07-21 UX-0~WS-4 + nimbalyst 시각 품질 v1 적용 완료)
