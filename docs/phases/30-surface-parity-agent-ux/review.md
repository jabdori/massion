# Phase 30 — TUI·Web 기능 동등화와 Guided Workspace UX 재설계 회고

> **상태**: in-progress
> **시작일**: 2026-07-16
> **최근 업데이트**: 2026-07-21
> **기준 source commit**: `938709f`

## 디자인 방향 전환

초기 "Calm Mission Control" 운영 관제 방향에서 "Guided Workspace" 안내형 업무 공간 방향으로 전환했습니다. 복잡한 AgentOS를 노출하는 것이 아니라, AgentOS가 사용자를 대신해 일을 정리해주는 제품으로 보이게 합니다.

### UX Projection 계층

`packages/application/src/design-tokens.ts`에 내부 기술 용어를 사용자 언어로 번역하는 공통 계층을 두었습니다. Web과 TUI가 같은 토큰을 공유하여 두 표면에서 문구와 상태 의미가 일관됩니다.

- `workStatusToken()`: 상태 → 친화적 라벨 + 기호 + 의미 색상
- `USER_STAGES`: 내부 6단계 → 사용자 4단계(요청 이해 / 자료와 계획 준비 / 작업 진행 / 결과 확인)
- `agentRoleToken()`: 에이전트 역할 → 친화적 역할명
- `approvalRiskToken()` / `approvalRiskFromPreview()`: 승인 위험도 → 친화적 영향 표현

## 현재 판정

### 구현 완료

**Web Console:**
- Guided Workspace 홈(요청 중심), 4단계 진행 바, 친화적 상태 라벨
- `/works` 작업 목록 페이지 + "작업" 내비게이션 메뉴
- "확인할 것" 내비게이션 카운트 배지 (실시간 승인 대기 수)
- OverviewPage 계획 미리보기 흐름 (요청 확인 → 진행 예상 단계 → 시작하기/수정)
- ApprovalsPage 친화적 위험도/영향 표현 (risk-banner)
- WorkPage 인라인 메시지 입력 (협업방 이동 없이 에이전트와 소통)
- 모바일 반응형 디자인 (768px, 480px 브레이크포인트)
- 접근성: ARIA progressbar, aria-label, aria-describedby, focus-visible, prefers-reduced-motion
- 기술 용어 번역: REV→버전, ARTIFACT→결과물 수, EXTENSIONS→확장, ORGANIZATION→조직
- 빈 화면 예시 안내, 오류 상태 복구 가이드
- 하드코딩 색상을 CSS 디자인 토큰으로 통일
- 기본 본문 16px, line-height 1.6

**TUI:**
- Guided Workspace 2패널 레이아웃, 친화적 상태 라벨
- Tab/Shift+Tab 뷰 전환 (작업→확인→대화→개요→협업→운영→구독)
- 4단계 진행 바, 친화적 에이전트 역할명
- 차단 상태 친화적 복구 안내 (Recovery Card)
- D 자세히 보기 토글
- 화면별 컨텍스트 도움말 바 (작업/확인/대화/구독 각각 다른 단축키 안내)
- 빈 작업 상태에서 "무엇을 도와드릴까요?" 입력 유도
- 작업 상세 첫 줄을 정적 라벨 대신 작업 제목으로 표시
- 승인 화면에 친화적 영향 표현 추가
- 패널 제목을 뷰별 사용자 언어로 표시

**문서:**
- README를 Guided Workspace 용어로 전면 업데이트

### 실제 실행 검증

- Z.AI GLM Coding Plan 1차 (2026-07-20): 간단한 요청(completed) + 복잡한 요청(Python 코드 작성, delivery 시간 초과로 blocked)
- Z.AI GLM Coding Plan 2차 (2026-07-21): 코드 작성 요청이 delivery 통과 → assurance(verifying) 도달, 산출물 2개 생성. 이전 제한 해결 확인.
- 개인 local token 만료 복구: 60초 만료 뒤 재초기화 없이 복구 확인
- Software Engineering 조직: Git fixture에서 백엔드 담당자 RED→GREEN 변경 + commit + 독립 Assurance 통과
- Core Office 협업방: 9명 참가자(8개 에이전트 조직 + 사용자), handoff 정상 동작

## 근거

- `938709f`: Web Console Guided Workspace UX 개선 (용어 번역, 디자인 토큰 통일, 빈 화면 예시, 오류 가이드)
- `7dee246`: TUI Guided Workspace UX 개선 (화면별 도움말, 빈 상태 입력 유도, 승인 영향 표현, 패널 제목)
- `eda3505`: 2차 GLM 도그푸딩 UAT 증거 추가, 회고 09bafc1 기준 업데이트
- `09bafc1`: Web 접근성 개선 (focus-visible 복원, aria-describedby)
- `b56fa22`: ARIA 속성 추가 (progressbar, aria-label, aria-describedby)
- `8424b45`: 전체 패키지 린트 에러 해결
- `ee49474`: 모바일 반응형 디자인 (768px, 480px 브레이크포인트)
- `e9c5131`: TUI 차단 상태 친화적 복구 안내 (Recovery Card)
- `beaeabd`: TUI·Web Guided Workspace 재설계
- `f3b41a4`: Guided Workspace 디자인 토큰 및 UX Projection 계층
- [GLM 도그푸딩 1차 UAT](../../evidence/phase-30/glm-dogfooding-uat-2026-07-20.md)
- [GLM 도그푸딩 2차 UAT](../../evidence/phase-30/glm-dogfooding-uat-2026-07-21.md)
- [업무 협업 UAT](../../evidence/phase-30/work-collaboration-local-uat-2026-07-20.md)

## 품질 게이트 결과 (commit `938709f` 기준)

- **ESLint**: 0 에러 (application, web, tui, cli 전체)
- **TypeScript**: 4개 패키지(application, web, tui, cli) typecheck 통과
- **테스트**: 총 518개 통과
  - Application: 242 passed, 2 skipped
  - Web: 62 passed (10 파일)
  - CLI: 151 passed (19 파일)
  - TUI: 63 passed, 1 skipped

## 남은 종료 조건

- 복수 Provider 계정 quota·fallback 검증 (단일 GLM 계정만 검증됨) — 사용자 계정 필요
- Claude 소비자 구독 실계정 UAT — 브라우저 OAuth 로그인 필요
- 접근성 parity UAT 최종 확인 (접근성 코드 구현은 완료, 화면 리더 실측 필요)
- 위 항목이 끝나기 전에는 Phase 30을 completed로 변경하지 않습니다.
