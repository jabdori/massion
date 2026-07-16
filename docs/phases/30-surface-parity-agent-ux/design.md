# Phase 30 — TUI·Web 기능 동등화와 AgentOS UX 재설계

> **상태**: in-progress
> **결정일**: 2026-07-16
> **기준 source commit**: `716fd08`
> **구현 브랜치**: `feat/phase-30-parity-ux`

## 1. 문제와 판정

현재 TUI와 Web Console은 같은 Application API를 사용하지만 동일한 제품 기능을 제공하지 않습니다. TUI에는 작업 배정, runtime 일시정지·재개·취소, 승인 취소가 있고 Web에는 접근 관리, 감사, 기억, 확장 설치와 OAuth가 있습니다. 양쪽 모두 새 업무와 협업방을 만드는 사용자 흐름이 없으며, 정상 순서의 실시간 사건이 현재 화면의 query를 갱신하지 않습니다.

Web query cache는 operation만 결과 키로 사용해 서로 다른 payload의 결과를 같은 슬롯에 저장합니다. `/works/A`에서 `/works/B`로 이동할 때 A의 데이터가 B 화면에 남아 잘못된 업무를 취소할 수 있으므로 시각 개선보다 먼저 수정해야 하는 안전 결함입니다.

Phase 30은 개인용 Core 범위의 모든 사용자 기능을 TUI와 Web 양쪽에 제공하고, 같은 command·query·권한·revision·결과·사건 계보를 검증합니다. 화면 배치는 환경에 맞게 달라도 기능과 의미는 같아야 합니다.

## 2. 제품 원칙

1. 기능 목록은 화면 코드가 아니라 공통 capability 계약이 정본입니다.
2. query identity는 operation과 정규화된 payload를 함께 포함합니다.
3. 실시간 사건은 영향받는 resource를 갱신하거나 stale로 표시하고 다시 읽습니다.
4. 모든 변경 command는 command ID, correlation ID, revision, 결과 상태와 감사 링크를 보존합니다.
5. 취소·거부·권한·설치·정책 적용은 대상, 영향, 사유와 진행 상태를 확인한 뒤 실행합니다.
6. 실제 인증 adapter가 없는 Provider는 연결 가능하다고 표시하지 않습니다.
7. TUI와 Web의 시각 구조는 달라도 상태 용어, 정보 우선순위, 기능 이름과 접근성 의미는 공유합니다.
8. 기능 동등성 계약을 통과한 뒤 시각 재설계를 적용합니다.

## 3. 요구사항

- `REQ-SURFACE-001`: TUI와 Web은 operation+payload query identity, resource 상태, command 결과, 사건 무효화 규칙을 공유하고 다른 resource의 데이터를 표시하지 않습니다.
- `REQ-SURFACE-002`: TUI와 Web은 업무 생성·후속 지시·분기·병합·취소, 작업 배정, runtime 제어, 협업방·채팅, 승인 흐름을 동일하게 제공합니다.
- `REQ-SURFACE-003`: TUI와 Web은 Provider·계정·quota·fallback, 감사, 기억, 접근, 확장, 백업·복원과 모델 평가실을 동일하게 관리합니다.
- `REQ-SURFACE-004`: TUI와 Web은 공통 view-model과 의미 기반 design token을 사용하고 키보드·스크린리더·좁은 화면에서 정보와 기능을 잃지 않습니다.
- `REQ-AGENT-HARNESS-001`: 실제 Agent runtime은 권한과 인과관계를 보존하는 협업 메시지·handoff·memory 계약을 사용하고 실행 계보를 양쪽 화면에 제공합니다.
- `REQ-SURFACE-UAT-001`: 동일 fixture와 실제 로컬 데이터베이스에서 TUI와 Web의 command envelope, 결과, 사건 cursor와 표시 상태가 일치합니다.

## 4. 공통 capability 계약

각 capability는 다음 정보를 선언합니다.

- 사람이 이해할 수 있는 이름과 안정적인 ID
- query, command와 타입이 지정된 payload
- 필요한 role·scope와 expected revision
- 위험 동작 여부, 필수 사유와 확인 정책
- 성공·대기·차단·실패·결과 미확정 상태
- 영향을 받는 resource와 실시간 사건
- TUI·Web 지원 상태와 명시적인 미지원 사유
- Provider·계정·모델 시도와 fallback 계보

UI는 operation 문자열과 payload를 중복 작성하지 않고 공통 builder와 decoder를 사용합니다. 기능 동등성 계약 테스트는 개인용 Core capability가 한쪽 화면에서 누락되면 CI를 실패시킵니다.

## 5. UX 방향

Massion의 시각 방향은 장난스러운 채팅 앱이 아니라 신뢰할 수 있는 개인용 운영실입니다. 첫 화면은 현재 상태, 사용자의 결정이 필요한 항목, 다음 행동과 그 근거 순서로 정보를 제공합니다.

TUI는 `80–99`열 단일 패널, `100–119`열 분할 패널, `120`열 이상 와이드 패널을 사용합니다. 목록과 대화는 스크롤·페이지 이동·현재 선택·남은 항목 수를 보여줍니다. 화면별 단축키만 하단에 표시하고 같은 키의 문맥을 명확히 합니다.

Web은 작은 화면에서 핵심 네 개 진입점과 더보기 구조를 사용합니다. 모든 query는 loading·empty·error·stale·retry 상태를 제공하고, 모든 dialog는 focus trap, Escape 종료와 기존 focus 복귀를 지원합니다. 조직 그래프는 실제 관계 데이터만 표시합니다.

## 6. 검증 전략

각 변경은 실패하는 회귀 테스트를 먼저 실행하고, 최소 구현 뒤 같은 테스트와 인접 테스트를 통과시킵니다. 최종 공통 시나리오는 온보딩 → 기존/새 Provider 계정 → 업무 생성 → 에이전트 배정 → 협업방 → 사용자·에이전트 대화 → runtime 실행 → 승인 → quota 소진 → fallback → 완료 → 감사·기억 → 백업·복원입니다.

Playwright Web과 OpenTUI renderer·tmux는 같은 fixture를 사용합니다. SSE 폭주·누락·역순, 세션 만료, 중복 command, stale revision, Provider 장애와 quota 미확인도 주입합니다.

## 7. 외부 기준

- React의 `useSyncExternalStore`는 같은 상태에서 안정적인 snapshot 값을 반환하고 실제 snapshot이 달라질 때만 다시 렌더링해야 합니다. [React 공식 문서](https://react.dev/reference/react/useSyncExternalStore)
- URL 경로 매개변수는 현재 resource identity의 일부이며 이동 시 새 매개변수로 데이터를 읽어야 합니다. [TanStack Router 공식 문서](https://tanstack.com/router/latest/docs/guide/path-params)
- OpenTUI 구현은 저장소에 고정된 `@opentui/core` API와 실제 renderer test를 기준으로 검증합니다. [OpenTUI 공식 저장소](https://github.com/anomalyco/opentui)

## 8. 완료 조건

1. capability matrix의 모든 개인용 기능이 양쪽 화면 action 또는 검증 가능한 미지원 사유를 가집니다.
2. 다른 payload의 query가 섞이지 않고 정상 사건이 열린 화면에 반영됩니다.
3. 실제 Agent가 협업방에서 메시지·handoff·memory를 사용하고 그 계보를 조회할 수 있습니다.
4. TUI `80×24`·`120×40`, Web `320`·`768`·`1440` viewport에서 정보 손실과 가로 overflow가 없습니다.
5. format, build, lint, typecheck, unit, contract parity, Playwright/axe, OpenTUI/tmux, 보안, release smoke가 clean clone에서 통과합니다.
6. Phase review와 evidence가 source commit·artifact digest·실행 결과와 연결됩니다.
