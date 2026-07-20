# Phase 30 — 개인용 Massion 완성

> **상태:** 진행 중. 개인용 로컬 런타임 세로 흐름은 완료했습니다.
> **현재 결정:** [개인용 로컬 런타임 기록](./slice-1b-local-surrealdb-3.2.1-design.md)

## 완료한 사용자 흐름

새 설치는 Massion이 관리하는 native SurrealDB 3.2.1 sidecar를 loopback에서 시작합니다. 애플리케이션은 인증된 WebSocket 연결을 사용하며, 이전 `rocksdb://./massion.db` 직접 실행 경로는 사용하지 않습니다.

빈 HOME에서 `massion`은 소유자 정보를 받은 뒤 TUI를 열고, `massion --web`도 같은 onboarding과 local runtime을 사용합니다. 공개 설치 명령은 `massion`, `massion-connector`뿐입니다.

## 검증 기록

- `d8530b1`: native SurrealDB 3.2.1에서 같은 Web session의 동시 인증 다섯 건을 재현하고, 접속 시각 갱신을 하나로 합쳤습니다.
- `f21cd21`: 이미 사용한 Web 로그인 코드는 내부 오류가 아니라 인증 실패(HTTP 401)로 응답하도록 회귀 테스트를 추가했습니다. 관련 제품·session 테스트 8개, 형식·lint·Application typecheck를 통과했습니다.
- 커밋 `f21cd21` 기준 개인용 artifact를 만들고, `node scripts/verify-release.mjs artifacts/release-1.0.0`의 종료 코드 0으로 SHA-256 확인, 설치, local runtime, 초기화, backup, 제거 후 data 보존을 확인했습니다.
- 새 HOME의 tmux에서 `massion` onboarding → native sidecar → TUI `live`를 확인했습니다. 이어 `massion --web`으로 발급한 같은 Web session에서 복구, 초기 다섯 조회, 조직 일치, 로그아웃을 확인했고 모든 조회는 HTTP 200이었습니다.
- 실제 Provider 계정 연결은 사용자 인증이 필요한 별도 UAT입니다. 이 기록은 local runtime 전환 범위만 완료로 판정합니다.
- `faacebd`, `1bf60eb`, `746c0d5`에서 동시 `run.start` 투영, TUI Work·Room 선택, 늦은 협업 메시지 응답을 각각 회귀 테스트로 고정했습니다.
- source commit `746c0d5` release artifact는 빈 환경 설치·초기화·backup·제거 후 data 보존 검증을 통과했습니다. 이어 실제 Web→TUI→Web 협업 메시지 흐름을 확인했습니다. 상세는 [업무 협업 UAT](../../evidence/phase-30/work-collaboration-local-uat-2026-07-20.md)에 기록합니다.

다음 조각도 failing test → 최소 구현 → focused verification → 실제 사용자 흐름 → 작은 commit 순서로 기록합니다. Cloud, 모델 평가실, 추가 provider·레지스트리 범위는 이 사용자 흐름을 대체하지 않습니다.
