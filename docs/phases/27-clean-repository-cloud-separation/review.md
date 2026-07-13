# Phase 27 — 이력 보존형 깨끗한 Massion Core 저장소 전환 회고

> **상태**: in-progress
> **검증일**: 2026-07-13
> **제품 코드 기준 커밋**: `2cb4f650f8a9e06ce8b07a8d17848304a07b3025`

## 1. 전환 결과

- 새 비공개 GitHub 저장소: [jabdori/massion](https://github.com/jabdori/massion)
- 새 저장소의 기본 브랜치: `main`
- 최초 synthetic root: `3c9697db15160c3d1fc904464894c0c2cd71a2b4`
- 전환 후 현재 커밋 수: 229개
- 새 저장소 tracked file 수: 899개
- 원본 저장소는 수정·삭제하지 않고 owner-only archive bundle로 보존했습니다.
- 새 저장소의 현재 tree·history·commit message에서 제외 대상 marker와 개인 경로는 0건입니다.

전환 이력은 Phase 1 Massion 구현 기준점(`9946b8a`)부터 export 기준점까지의 제품 커밋을 재작성해 보존합니다. 원본 hash와 새 hash의 관계, 제외된 commit 사유와 bundle checksum은 저장소 밖 private archive manifest가 소유합니다.

## 2. 새 저장소 검증

다음 검증은 현재 커밋에서 새 저장소 작업 트리를 기준으로 실행했습니다.

| 검증 | 결과 |
|---|---|
| `pnpm verify` | 종료 코드 0: format, build, lint, typecheck, 전체 test, 문서 검증 통과 |
| `pnpm verify:security` | 종료 코드 0: 14개 test file, 67개 통과·1개 조건부 생략, moderate/high/critical 0 |
| `pnpm verify:hardening` | 종료 코드 0: 26개 통과, 500 요청·동시성 32·실패 0, p95 14.26ms |
| `pnpm release:build` | 종료 코드 0: commit-bound local/deploy archive 생성 |
| `pnpm verify:release` | 종료 코드 0: 설치·실행·백업·복구·제거 후 data 보존 통과 |

## 3. Phase 24 인계와 UAT

최종 release archive를 격리된 tmux 세션에서 실행한 UAT 영수증은 다음 계보를 기록합니다.

- release commit: `b3359a857bdf733f65febd01aa588e4c14d749be`
- release artifact digest: `sha256:c30e271041d8b6b40f9c2fdd1c12904bc6fcdd0d77366200975d3a97cb33e88b`
- 결과: `passed: 1`, `failed: 0`, `not-run: 11`
- 통과 범위: 설치, version, bundled connector doctor, local start, owner init, status/readiness, provider catalog, SSE watch, restart, backup, restore, uninstall data preservation
- Codex consumer login: `interactive-login-required`
- Claude consumer login: `provider-approval-required`
- Z.AI Coding Plan: `provider-approval-required`
- 두 번째 계정·공개 failure injection·다중 사용자 승인 시나리오는 필요한 외부 계정 또는 승인 전제조건이 없어 `not-run`으로 남겼습니다.

초기 UAT에서 SSE watch가 열린 상태의 `local stop`이 종료 코드 2를 반환했습니다. 원인은 drain 시 활성 SSE 연결을 닫지 않아 HTTP server close가 열린 연결을 기다린 것이었습니다. 회귀 테스트를 먼저 실패시킨 뒤 활성 stream을 drain에서 닫도록 수정했고, 최종 release UAT에서 `restart-stop`을 포함한 전체 lifecycle이 종료 코드 0으로 통과했습니다.

## 4. 남은 작업

- 공식적으로 승인된 Codex 대화형 로그인 후 실제 구독·모델 발견·quota snapshot 시나리오를 실행합니다.
- 두 번째 계정과 두 번째 사용자가 제공되면 회전·공유 lease·fallback·중단·재개 시나리오를 실행합니다.
- Phase 24의 실제 외부 계정 검증이 끝난 뒤 Phase 24 회고를 completed로 닫습니다.
- Phase 25 모델 최적화 실험실은 이 저장소의 다음 기준 커밋에서 시작합니다.
- Cloud 저장소·결제·관리형 운영 기능은 실제 사업 요구가 생길 때 별도 Phase로 설계합니다.
