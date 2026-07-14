# Phase 27 — 이력 보존형 깨끗한 Massion Core 저장소 전환 회고

> **상태**: completed
> **검증일**: 2026-07-13
> **제품 코드 기준 커밋**: `2cb4f650f8a9e06ce8b07a8d17848304a07b3025`

## 1. 전환 결과

- 새 비공개 GitHub 저장소: [jabdori/massion](https://github.com/jabdori/massion)
- 새 저장소의 기본 브랜치: `main`
- 최초 synthetic root: `3c9697db15160c3d1fc904464894c0c2cd71a2b4`
- 제품 코드 검증 기준 커밋까지의 보존 커밋 수: 237개 (2026-07-13 기준)
- 새 저장소 tracked file 수: 905개 (2026-07-13 기준)
- 원본 저장소는 수정·삭제하지 않고 owner-only archive bundle로 보존했습니다.
- 새 저장소의 현재 tree·history·commit message에서 제외 대상 marker와 개인 경로는 0건입니다.

전환 이력은 Phase 1 Massion 구현 기준점(`9946b8a`)부터 export 기준점까지의 제품 커밋을 재작성해 보존합니다. 원본 hash와 새 hash의 관계, 제외된 commit 사유와 bundle checksum은 저장소 밖 private archive manifest가 소유합니다.

## 2. 새 저장소 검증

제품 코드 게이트는 `30d3bdc`에서, 빈 복제본 게이트는 `6777f3b`에서 실행했으며 이후 커밋은 문서만 변경했습니다.

| 검증 | 결과 |
|---|---|
| `pnpm verify` | 종료 코드 0: format, build, lint, typecheck, 전체 test, 문서 검증 통과 |
| `pnpm verify:security` | 종료 코드 0: 14개 test file, 67개 통과·1개 조건부 생략, moderate/high/critical 0 |
| `pnpm verify:hardening` | 종료 코드 0: 26개 통과, 500 요청·동시성 32·실패 0, p95 14.26ms |
| `pnpm release:build` | 종료 코드 0: commit-bound local/deploy archive 생성 |
| `pnpm verify:release` | 종료 코드 0: 설치·실행·백업·복구·제거 후 data 보존 통과 |
| 빈 디렉터리 `git clone --no-local` 검증 | 종료 코드 0: frozen install, 전체 `pnpm verify`, release build/verify 통과; [상세 증거](../../evidence/phase-27/clean-clone-verification-2026-07-13.md) |

깨끗한 복제본 release 기준은 `6777f3b0a5922e9349862214843ebf98905a53cc`이며 local archive digest는 `sha256:3771998673eb9720336dc8db4321a078c431be9c2f60b96cfddad74b3be51f67`입니다. 원격 `main`은 이 기준을 포함한 후속 문서 커밋으로 푸시되어 있습니다.

## 3. Phase 24 인계와 UAT

초기 인계 UAT는 아래의 역사적 기준을 남겼고, 2026-07-14에 현재 Massion Core 기준으로 Codex 인증 재검증을 추가 실행했습니다.

- release commit: `b3359a857bdf733f65febd01aa588e4c14d749be`
- release artifact digest: `sha256:c30e271041d8b6b40f9c2fdd1c12904bc6fcdd0d77366200975d3a97cb33e88b`
- 결과: `passed: 1`, `failed: 0`, `not-run: 11`
- 통과 범위: 설치, version, bundled connector doctor, local start, owner init, status/readiness, provider catalog, SSE watch, restart, backup, restore, uninstall data preservation
- 초기 Codex consumer login: `interactive-login-required`
- Claude consumer login: `provider-approval-required`
- Z.AI Coding Plan: `provider-approval-required`
- 두 번째 계정·공개 failure injection·다중 사용자 승인 시나리오는 필요한 외부 계정 또는 승인 전제조건이 없어 `not-run`으로 남겼습니다.

최신 후속 UAT 영수증은 [`subscription-uat-2026-07-14.md`](../../evidence/phase-24/subscription-uat-2026-07-14.md)에 기록했습니다.

- release commit: `00f77e6f8471895694b2e3600b85f2ee0dad4a5d`
- local archive digest: `sha256:54b4c151d8bb819b5a305c45a57f41a7b7dd657007982bd9eb2b558540ea23bf`
- 결과: `passed: 1`, `failed: 1`, `not-run: 9`
- Codex OAuth 로그인 동의·account·doctor·quota·adaptive policy 조회: 통과
- 실제 `run subscription acceptance`: 180초 `network` timeout
- Claude·Z.AI·복수 계정·복수 사용자·failure injection: 외부 승인 또는 계정 전제조건으로 `not-run`

초기 UAT에서 SSE watch가 열린 상태의 `local stop`이 종료 코드 2를 반환했습니다. 원인은 drain 시 활성 SSE 연결을 닫지 않아 HTTP server close가 열린 연결을 기다린 것이었습니다. 회귀 테스트를 먼저 실패시킨 뒤 활성 stream을 drain에서 닫도록 수정했고, 최종 release UAT에서 `restart-stop`을 포함한 전체 lifecycle이 종료 코드 0으로 통과했습니다.

## 4. 후속 작업

- Codex 인증은 완료되었으므로, 외부 모델 응답이 가능한 상태에서 실제 subscription run과 역할별 평가를 재실행합니다. 현재는 network timeout으로 성공을 확정하지 않습니다.
- 두 번째 계정과 두 번째 사용자가 제공되면 Phase 24의 회전·공유 lease·fallback·중단·재개 시나리오를 실행합니다.
- Phase 24의 실제 외부 계정 검증이 끝난 뒤 Phase 24 회고를 completed로 닫습니다.
- Phase 25 모델 최적화 실험실은 이 저장소의 다음 기준 커밋에서 시작합니다.
- Cloud 저장소·결제·관리형 운영 기능은 실제 사업 요구가 생길 때 별도 Phase로 설계합니다.

## 5. 후속 Docker 운영 검증

2026-07-14에 기존 named volume을 사용하는 Docker Compose 팀 배포를 다시 기동하고, owner-only backup·새
database restore·복구 DB readiness·HTTPS 인증 경계를 실제 container에서 검증했습니다. 반복 기동에서 발견한
`volume-init` 재귀 권한 오류와 runtime 계정의 import 권한 부족을 수정했으며, 상세 결과는
[Docker 팀 배포·복구 검증 증거](../../evidence/phase-27/docker-team-uat-2026-07-14.md)에 기록했습니다.
