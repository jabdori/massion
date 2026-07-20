# Phase 30 업무 협업 local UAT — 2026-07-20

> **source commit:** `746c0d5`
> **결과:** Provider 없는 개인용 local 흐름 통과

## 확인한 흐름

1. release artifact를 빈 환경에 설치하고 native SurrealDB 3.2.1 sidecar, onboarding, TUI와 Web Console을 시작했습니다.
2. Web에서 Work를 만들고 Core Office에 두 메시지를 보냈습니다.
3. TUI에서 새 Work를 선택한 뒤 대화 화면을 처음 열었습니다. 수동 새로고침 없이 같은 두 메시지가 표시됐습니다.
4. TUI에서 세 번째 메시지를 보내자 Web에 실시간으로 표시됐습니다.

source commit `746c0d5`에서 만든 release artifact 검증은 설치, local runtime, 초기화, backup, 제거 뒤 data 보존까지 종료 코드 0으로 통과했습니다. 모델 경로가 없는 환경의 Representative 실행은 예상대로 `blocked_model_unavailable`이었습니다.

## 아직 확인하지 않은 범위

실제 Provider 계정으로 Representative가 성공한 뒤 Context & Strategy handoff와 memory를 사용하는 흐름, 복수 계정 quota·fallback은 이 UAT에 포함하지 않았습니다.
