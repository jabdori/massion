# Phase 30 — TUI·Web 기능 동등화와 AgentOS UX 재설계 회고

> **상태**: in-progress
> **시작일**: 2026-07-16
> **기준 source commit**: `716fd08`

## 현재 판정

구현 시작 전 공격 리뷰에서 TUI와 Web은 같은 Application API를 사용하는 부분 화면이며 기능적으로 동등하지 않음을 확인했습니다. 가장 먼저 Web의 payload 없는 query cache identity, 정상 사건 뒤 stale 화면, 세션 만료 복구와 위험 command 계약을 수정합니다.

현재 Agent runtime에는 협업방 message 도구와 실제 대화 memory 주입 경로가 확인되지 않았으므로, 데이터 구조의 존재만으로 Agent 간 직접 협업이 완료되었다고 판정하지 않습니다. Provider 인증도 현재 실제 사용자 경로가 확인된 adapter 범위와 UI 노출을 일치시킵니다.

## 기준선

`716fd08`에서 `pnpm verify`를 실행해 format, 전체 workspace build, lint, typecheck, root 85개 테스트, 모든 workspace 테스트, Web 18개 테스트, TUI 54개 Vitest와 13개 Bun renderer 테스트, 문서 검증의 종료 코드 0을 확인했습니다. 상세 실행 환경과 후속 RED·GREEN 기록은 Phase 30 evidence에 누적합니다.

## 정합성 원장 이식성 보정 (2026-07-18)

안전 스냅샷이 있는 원본 저장소만 통과하는 검증은 새 복제본의 문서 검증을 막으므로, 원장에 안전 diff의 337개 `status<TAB>path` 목록과 SHA-256을 고정했습니다. 기본 검증은 다시 계산한 값과 검증기에 고정한 기준 SHA-256, 공용 파일 24개·owner 62개·primary 소유 조각 집합을 대조합니다. 원본 저장소의 실제 Git diff·exact hunk 위치 검증은 `--require-safety`에서만 수행합니다.

공용 파일의 소유 근거는 단어 검색(anchor)이 아니라 의미, 시작·끝 행, 이전 문맥, 본문, 다음 문맥으로 구성된 정확한 owner 객체입니다. 엄격 모드는 이 객체가 안전 커밋에서 한 번만 일치하고 base→safety 추가 hunk 안에 있는지 확인합니다. 구현 계획의 완료 체크박스는 독립 복구 코드 커밋과 최신 검증 근거가 없으므로 모두 제거했습니다.

이 보정의 RED→GREEN 회귀 검증은 정합성 원장 테스트, 문서 검증 테스트, 기본·엄격 원장 검증, `pnpm verify:docs`로 기록합니다. 이는 추적성 장치의 완료일 뿐이며, Phase 30 기능·사용자 인수 테스트(UAT) 또는 출시 완료 판정이 아닙니다.

## 남은 종료 조건

구현 계획의 모든 항목, 실제 Provider가 필요한 명시적 선행조건, 공통 parity UAT와 clean clone release 검증이 끝나기 전에는 이 Phase를 completed로 변경하지 않습니다.
