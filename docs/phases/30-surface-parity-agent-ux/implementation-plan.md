# Phase 30 — 개인용 Massion 완성

> **상태:** in-progress
> **제품 결정:** [개인용 로컬 런타임](./slice-1b-local-surrealdb-3.2.1-design.md)

Massion을 개인이 바로 설치하고 사용할 수 있는 완성 제품으로 만듭니다. 이전 local data를 이식하지 않는 clean reset이며, 현재 구현은 native SurrealDB 3.2.1 local runtime부터 시작합니다.

## 진행 순서

1. native local runtime과 clean reset
2. onboarding·profile renewal·local supervisor
3. TUI와 Web의 작업·채팅·agent·provider·approval·backup/restore 동등화
4. release install·update·upgrade와 공개 명령 정리
5. clean clone, tmux, TUI, Web, backup/restore, provider 연결 검증과 Phase 회고

각 조각은 failing test → 최소 구현 → focused verification → 작은 commit 순서로 진행합니다. 현재 조각의 상세 실행 계획은 [native local runtime foundation](../../superpowers/plans/2026-07-19-native-local-runtime.md)에 둡니다.
