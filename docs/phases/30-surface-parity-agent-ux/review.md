# Phase 30 — TUI·Web 기능 동등화와 AgentOS UX 재설계 회고

> **상태**: in-progress
> **시작일**: 2026-07-16
> **기준 source commit**: `716fd08`

## 현재 판정

구현 시작 전 공격 리뷰에서 TUI와 Web은 같은 Application API를 사용하는 부분 화면이며 기능적으로 동등하지 않음을 확인했습니다. 가장 먼저 Web의 payload 없는 query cache identity, 정상 사건 뒤 stale 화면, 세션 만료 복구와 위험 command 계약을 수정합니다.

현재 Agent runtime에는 협업방 message 도구와 실제 대화 memory 주입 경로가 확인되지 않았으므로, 데이터 구조의 존재만으로 Agent 간 직접 협업이 완료되었다고 판정하지 않습니다. Provider 인증도 현재 실제 사용자 경로가 확인된 adapter 범위와 UI 노출을 일치시킵니다.

## 기준선

`716fd08`에서 `pnpm verify`를 실행해 format, 전체 workspace build, lint, typecheck, root 85개 테스트, 모든 workspace 테스트, Web 18개 테스트, TUI 54개 Vitest와 13개 Bun renderer 테스트, 문서 검증의 종료 코드 0을 확인했습니다. 상세 실행 환경과 후속 RED·GREEN 기록은 Phase 30 evidence에 누적합니다.

## 남은 종료 조건

구현 계획의 모든 항목, 실제 Provider가 필요한 명시적 선행조건, 공통 parity UAT와 clean clone release 검증이 끝나기 전에는 이 Phase를 completed로 변경하지 않습니다.
