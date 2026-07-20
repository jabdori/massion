# Phase 30 — TUI·Web 기능 동등화와 AgentOS UX 재설계 회고

> **상태**: in-progress
> **시작일**: 2026-07-16
> **기준 source commit**: `746c0d5`

## 현재 판정

개인용 local 세로 흐름은 실제 artifact에서 확인됐습니다. 빈 환경 설치와 onboarding 뒤 Web에서 Work와 두 협업 메시지를 만들었고, TUI에서 같은 Work를 선택해 대화 화면을 처음 열었을 때 새로고침 없이 두 메시지가 표시됐습니다. TUI에서 보낸 세 번째 메시지도 Web에 실시간 반영됐습니다.

모델 경로가 없는 제한 모드에서는 Representative가 `blocked_model_unavailable`으로 끝나는 것도 확인했습니다. Z.AI GLM Coding Plan은 실제 계정 연결과 Core 완료 실행까지 확인했습니다. 계정별 quota와 복수 계정 fallback은 아직 완료로 기록하지 않습니다.

개인 local file profile은 만료 시 loopback server에서만 새 access token을 발급받아 자동 교체합니다. 깨끗한 환경에서 60초 token 만료 뒤 `massion status --json`이 재초기화 없이 복구되는 것을 확인했습니다.

설치된 Software Engineering 조직은 실제 Git fixture에서 백엔드 담당자를 선택해 RED→GREEN 변경과 commit을 수행했고, 독립 Assurance까지 통과했습니다. 원본 Repository는 변경되지 않았습니다.

## 근거

- `faacebd`: 같은 조직의 event projection transaction을 직렬화했습니다.
- `1bf60eb`: Work를 바꿀 때 해당 Work의 협업방도 함께 선택하도록 고쳤습니다.
- `746c0d5`: 이전 방의 늦은 메시지 응답을 현재 방에 표시하지 않도록 고쳤습니다.
- source commit `746c0d5` release artifact는 빈 환경 설치·local runtime·초기화·backup·제거 후 data 보존 검증을 통과했습니다.
- 실제 화면 검증 결과는 [업무 협업 UAT](../../evidence/phase-30/work-collaboration-local-uat-2026-07-20.md)에 있습니다.
- Z.AI Coding Plan의 계약·실제 계정 결과는 [Z.AI Coding Plan 검증](../../evidence/phase-30/zai-core-office-uat-2026-07-20.md)에 있습니다.
- 개인 local token 만료 복구 결과는 [local access token UAT](../../evidence/phase-30/local-access-refresh-uat-2026-07-20.md)에 있습니다.

## 남은 종료 조건

- 복수 Provider 계정 quota·fallback을 검증합니다.
- TUI와 Web의 나머지 개인용 capability 동등성, 접근성·반응형 화면, 전체 parity UAT를 끝냅니다.
- 위 항목이 끝나기 전에는 Phase 30을 completed로 변경하지 않습니다.
