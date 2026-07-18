# Phase 30 — 개인용 Massion 완성

> **상태:** 진행 중. 개인용 로컬 런타임 세로 흐름은 완료했습니다.
> **현재 결정:** [개인용 로컬 런타임 기록](./slice-1b-local-surrealdb-3.2.1-design.md)

## 완료한 사용자 흐름

새 설치는 Massion이 관리하는 native SurrealDB 3.2.1 sidecar를 loopback에서 시작합니다. 애플리케이션은 인증된 WebSocket 연결을 사용하며, 이전 `rocksdb://./massion.db` 직접 실행 경로는 사용하지 않습니다.

빈 HOME에서 `massion`은 소유자 정보를 받은 뒤 TUI를 열고, `massion --web`도 같은 onboarding과 local runtime을 사용합니다. 공개 설치 명령은 `massion`, `massion-connector`뿐입니다.

## 검증 기록

- `24811ea`: sidecar health 뒤 namespace와 database를 준비하는 실패 테스트와 구현을 추가했습니다.
- `f9e8fd2`: 공개 `massion-server` 래퍼와 릴리스 검증의 직접 RocksDB 복구 경로를 제거했습니다.
- `e67ffd4`: macOS `/var`·`/private/var` 경로 별칭에서 sidecar 종료가 실패하는 재현 테스트를 추가하고, 종료 시에도 검증된 실행 파일의 canonical path를 사용하도록 수정했습니다.
- `b0d3928`: 구독 UAT의 직접 server·RocksDB 복구 분기와 설치 안내를 제거했습니다. 공개 명령만 쓰는지 확인하는 실패 테스트를 추가했습니다.
- focused CLI 테스트 22개, CLI typecheck, release installer 테스트 13개를 통과했습니다.
- UAT 테스트 30개와 `CI=true pnpm verify:release`가 새 릴리스 산출물에서 설치, 자동 runtime 준비, 초기화, 상태, backup, 중지, 제거를 통과했습니다.
- 새 artifact의 tmux lifecycle UAT는 release 1건 성공·실패 0건으로 설치, 재시작, backup, 종료, 제거를 확인했습니다. provider 인증이 필요한 9개 시나리오는 미실행으로 기록했습니다.
- tmux의 빈 HOME에서 `massion` onboarding → TUI `live`, `massion --web` onboarding → Web Console HTTP 200, 인증 Web session → snapshot·현재 사용자 조회를 확인했습니다.

다음 조각도 failing test → 최소 구현 → focused verification → 실제 사용자 흐름 → 작은 commit 순서로 기록합니다. Cloud, 모델 평가실, 추가 provider·레지스트리 범위는 이 사용자 흐름을 대체하지 않습니다.
