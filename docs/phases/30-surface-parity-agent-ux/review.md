# Phase 30 — TUI·Web 기능 동등화와 Guided Workspace UX 재설계 회고

> **상태**: in-progress
> **시작일**: 2026-07-16
> **최근 업데이트**: 2026-07-21
> **기준 source commit**: `0557486`

## 디자인 방향 전환

초기 "Calm Mission Control" 운영 관제 방향에서 "Guided Workspace" 안내형 업무 공간 방향으로 전환했습니다. 복잡한 AgentOS를 노출하는 것이 아니라, AgentOS가 사용자를 대신해 일을 정리해주는 제품으로 보이게 합니다.

### UX Projection 계층

`packages/application/src/design-tokens.ts`에 내부 기술 용어를 사용자 언어로 번역하는 공통 계층을 두었습니다. Web과 TUI가 같은 토큰을 공유하여 두 표면에서 문구와 상태 의미가 일관됩니다.

- `workStatusToken()`: 상태 → 친화적 라벨 + 기호 + 의미 색상
- `USER_STAGES`: 내부 6단계 → 사용자 4단계(요청 이해 / 자료와 계획 줄비 / 작업 진행 / 결과 확인)
- `agentRoleToken()`: 에이전트 역할 → 친화적 역할명
- `approvalRiskToken()` / `approvalRiskFromPreview()`: 승인 위험도 → 친화적 영향 표현

## 현재 판정

### 구현 완료

- Web: Guided Workspace 홈(요청 중심), 4단계 진행 바, 친화적 상태 라벨
- Web: `/works` 작업 목록 페이지 + "작업" 내비게이션 메뉴 추가
- Web: "확인할 것" 내비게이션 카운트 배지
- Web: OverviewPage 계획 미리보기 흐름 (요청 확인 → 진행 예상 단계 → 시작하기/수정)
- Web: ApprovalsPage 친화적 위험도/영향 표현 (risk-banner, "영향이 작습니다" / "주의가 필요합니다" / "되돌리기 어렵습니다")
- TUI: Guided Workspace 2패널 레이아웃, 친화적 상태 라벨, D 자세히 보기 토글
- TUI: 4단계 진행 바, 친화적 에이전트 역할명

### 실제 실행 검증

- Z.AI GLM Coding Plan: 간단한 요청(Run completed) + 복잡한 요청(Python 코드 작성, evidence 통과→delivery→assurance 진행 확인)
- 개인 local token 만료 복구: 60초 만료 뒤 재초기화 없이 복구 확인
- Software Engineering 조직: Git fixture에서 백엔드 담당자 RED→GREEN 변경 + commit + 독립 Assurance 통과

## 근거

- `0557486`: Guided Workspace works list, plan preview, approval risk expression 추가
- `beaeabd`: TUI·Web Guided Workspace 재설계 (디자인 토큰, 4단계 진행 바, 친화적 라벨)
- `f3b41a4`: Guided Workspace 디자인 토큰 및 UX Projection 계층 추가
- `e933a64`: Assurance 파이프라인 연결, local access refresh, Z.AI verifier
- `b28b159`: Provider 승인 게이트 제거 (Claude Code, Z.AI Coding Plan)
- 실제 화면 검증: [업무 협업 UAT](../../evidence/phase-30/work-collaboration-local-uat-2026-07-20.md)
- Z.AI Coding Plan 검증: [Z.AI Coding Plan 검증](../../evidence/phase-30/zai-core-office-uat-2026-07-20.md)

## 테스트 결과

- Web 테스트: 62개 통과 (10 파일)
- TUI 테스트: 63 passed, 1 skipped
- Application 단위 테스트: 156개 통과
- 전체 typecheck: 통과

## 남은 종료 조건

- 복수 Provider 계정 quota·fallback 검증 (단일 GLM 계정만 검증됨)
- Claude 소비자 구독 실계정 UAT
- TUI·Web 접근성·반응형 화면 전체 parity UAT
- 위 항목이 끝나기 전에는 Phase 30을 completed로 변경하지 않습니다.
