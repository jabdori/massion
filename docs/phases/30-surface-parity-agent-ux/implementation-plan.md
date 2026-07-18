# Phase 30 — TUI·Web 기능 동등화와 AgentOS UX 재설계 구현 계획

> **상태**: in-progress
> **설계**: `docs/phases/30-surface-parity-agent-ux/design.md`
> **방법**: 기준선 고정 → 공통 계약 → 안전성 P0 → 핵심 기능 동등화 → 운영 동등화 → 시각 재설계 → 하네스·UAT → 회고

## Task 0B. 이력 정합성 복구

> 상세 복구 원장: [Phase 30 History Reconciliation Implementation Plan](./reconciliation-plan.md)

- 기록된 후보: 기준 HEAD와 안전 스냅샷을 기준으로 변경 상태를 감사(audit)한 이력이 있습니다. 현재 복구 후보의 재검증 근거는 아직 연결하지 않았습니다.
- 기록된 후보: 불변 안전 스냅샷(immutable safety snapshot)의 참조, 커밋, 트리를 고정한 이력이 있습니다. 현재 복구 후보의 독립 코드 커밋 근거는 아직 없습니다.
- 재검증 필요: 깨끗한 기준선(clean base)에서 동결 설치 후 전체 `pnpm verify`가 종료 코드 `0`이었다는 기록은 별도 baseline evidence 커밋과 연결되기 전까지 완료로 표시하지 않습니다.
- [ ] 안전 스냅샷에서 원자적인 복구 조각(slice)별로 구현을 재구성합니다.
- [ ] 실제 코드 커밋 SHA와 검증 결과에 맞게 근거·체크리스트·추적성 표를 정정합니다.
- [ ] 현재 복구 후보에서 전체 `pnpm verify`와 릴리스 검증을 다시 실행합니다.
- [ ] Playwright, OpenTUI, tmux, 백업·복원, 공급자 사용자 인수 테스트(UAT)를 완료합니다.

## Task 1. 기준선과 공격 리뷰 고정

- 기록된 후보: `716fd08`에서 격리 브랜치와 워크트리를 만들고 frozen dependency 설치를 수행한 이력이 있습니다. 현재 복구 후보의 독립 근거로는 아직 승격하지 않았습니다.
- 기록된 후보: format·전체 build·lint·typecheck·test·문서 검증의 종료 코드 0 기준선 기록이 있습니다. 이 기록은 baseline evidence 커밋과 연결될 때까지 재검증 필요 상태입니다.
- 기록된 후보: CLI·온보딩·Agent harness·TUI·Web·시각 UX 공격 리뷰를 코드와 실제 실행 결과로 분류한 이력이 있습니다. 현재 복구 후보의 완료 근거는 아닙니다.
- 기록된 후보: 기준선 명령, source commit과 환경을 Phase 30 evidence에 기록하려는 후보가 있습니다. 실제 evidence SHA와 연결되기 전까지 재검증 필요 상태입니다.

## Task 2. 공통 query·resource·사건 계약

- 기록된 후보: 서로 다른 payload의 query가 같은 결과 슬롯을 공유하는 실패 테스트를 추가한 이력이 있습니다. 현재 복구 브랜치의 독립 커밋과 최신 검증 근거가 필요합니다.
- 기록된 후보: operation+정규 payload를 query identity로 사용하고 Web hook과 초기 load를 같은 계약으로 옮긴 후보가 있습니다. 독립 복구와 최신 검증 전에는 완료로 표시하지 않습니다.
- [ ] TUI의 선택된 업무·협업방 query도 같은 resource identity와 응답 generation을 사용합니다.
- [ ] loading·ready·empty·error·stale·retry 상태와 event→resource invalidation을 공통 계약으로 정의합니다.
- [ ] Web과 TUI에서 정상 SSE 사건, gap, 역순, 재연결과 세션 만료를 검증합니다.

## Task 3. 업무·에이전트·협업·승인 기능 동등화

- [ ] TUI와 Web에 새 업무 composer와 업무 목록·상세·후속 지시·분기·병합·취소를 제공합니다.
- [ ] 작업 배정·재배정과 runtime 실행·일시정지·재개·취소를 양쪽에 제공합니다.
- [ ] 협업방 생성·참가·퇴장·종료와 실시간 다중 참여자 채팅을 양쪽에 제공합니다.
- [ ] 승인·거부·취소, 사용자 사유, 영향 미리보기와 감사 링크를 양쪽에 제공합니다.
- [ ] 모든 위험 command에 확인·사유·pending·중복 방지·결과 미확정 복구를 적용합니다.

## Task 4. 운영 기능 동등화

- [ ] Provider 인증·profile 재사용·새 계정·doctor·quota·fallback 계보를 양쪽에 제공합니다.
- [ ] 감사·기억·접근 관리·Extension Registry·OAuth·백업·복원을 양쪽에 제공합니다.
- [ ] 모델 평가실의 정책·bundle·evaluation·recommendation·batch·recovery를 타입이 지정된 폼으로 제공합니다.
- [ ] 실제 adapter가 없는 Provider는 명확한 미지원 사유로 실패 폐쇄합니다.

## Task 5. 공통 view-model과 시각 재설계

- [ ] 상태 → 결정 필요 → 다음 행동 → 근거 순서의 공통 view-model을 정의합니다.
- [ ] 의미 기반 색·간격·타이포그래피·focus·상태 token을 TUI와 Web에 적용합니다.
- [ ] TUI 반응형 패널·scroll·paging·focus·action palette와 문맥별 도움말을 구현합니다.
- [ ] Web 모바일 정보 구조·query boundary·danger dialog·live feed·실제 조직 그래프를 구현합니다.
- [ ] 키보드·스크린리더·reduced motion·한국어 시간 표시와 viewport 회귀를 검증합니다.

## Task 6. Agent harness 협업·memory·계보

- [ ] Agent runtime에 권한이 제한된 협업 message read/post/reply와 handoff 도구를 주입합니다.
- [ ] 업무·협업방 범위의 memory를 실제 prompt context와 영속 기록에 연결하고 삭제·출처 경계를 제공합니다.
- [ ] 병렬 handoff의 부분 성공·취소·checkpoint와 스트림 중단 후 결과 미확정 복구를 구현합니다.
- [ ] provider/account/model route/attempt/fallback/terminal outcome 계보를 양쪽에서 조회합니다.

## Task 7. Parity E2E·UAT와 출시 게이트

- [ ] 공통 scenario runner를 fake API와 실제 로컬 SurrealDB에서 실행합니다.
- [ ] Playwright와 OpenTUI renderer·tmux가 같은 command envelope·revision·outcome·cursor·resource를 검증합니다.
- [ ] 접근성·반응형·성능·보안·비밀정보 비노출·backup/restore를 검증합니다.
- [ ] clean clone에서 install·update·upgrade·`massion`·`massion --web`·release smoke를 실행합니다.
- [ ] README·요구사항 추적표·evidence·Phase review를 source commit과 artifact digest로 닫습니다.
