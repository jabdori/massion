# Phase 27 — Docker 팀 배포·복구 검증 증거

> **검증일**: 2026-07-14
> **제품 코드 기준 커밋**: `c4cd11ab2382b8fa49dace000dacc3362b4ee53e`
> **민감정보**: secret 원문, 개인 경로, raw container log는 저장하지 않음

## 검증 범위

기존 named volume이 이미 채워진 Docker Compose 환경을 보존한 채 재기동·백업·복구·readiness·HTTPS 경계를
확인했습니다. 검증용 secret은 repository 밖의 owner-only 파일로 생성했으며, source tree와 image environment에
비밀 원문을 넣지 않았습니다.

## 실제 결과

| 단계 | 결과 |
|---|---|
| `docker compose config --quiet` | 통과 |
| `docker compose build` | Massion 1.0.0, SurrealDB 3.2.0, Caddy 2.11.4 image 생성 통과 |
| 최초 `up -d --wait` | volume-init, database-provision, Massion, Caddy readiness 통과 |
| 이미 사용한 volume에서 반복 `up -d --wait` | 통과; volume-init 재귀 `chown` 권한 오류가 재발하지 않음 |
| `/health/ready`·`/health/live` | 각각 `ready`, `live` |
| 인증 없는 `/api/v1/status` | HTTP 401 및 `APP_HTTP_AUTH` envelope |
| owner-only backup | `server.backup.completed`, migration 87, SHA-256 checksum 생성 |
| 새 target database provisioning | `server.provision.completed` |
| 새 target database restore | `server.restore.completed`, 동일 migration 87·checksum 일치 |
| 복구 DB server readiness | `database`, `migrations`, `runtime-recovery`, `subscription-quota` 포함 전체 `ready` |

## 권한 경계에서 발견·수정한 문제

초기 복구 시도에서 runtime SurrealDB 계정(`EDITOR`)으로 import하면 SurrealDB가 403을 반환했습니다. runtime
서비스에 database owner 권한을 추가하지 않고 다음처럼 경계를 수정했습니다.

- runtime API container는 장기 실행 credential만 가집니다.
- `database-provision` 일회성 container가 owner provisioning secret과 backup volume을 사용합니다.
- `restore` 명령은 원격 DB에서 owner 인증을 요구하고, 새 database 이름을 사용합니다.
- restore runbook과 Compose 회귀 테스트가 이 경계를 고정합니다.

이 수정은 `1d408d2`에 반영했고, 현재 source 기준으로 image를 다시 빌드해 같은 복구 흐름을 재실행했습니다.

## 잔여 범위

Docker 운영 경계와 local lifecycle은 통과했지만, 외부 Provider 로그인·실제 모델 응답·두 번째 계정·다중 사용자
승인 시나리오는 별도 자격 증명과 사용자 승인이 필요합니다. 해당 상태는 [Phase 24 UAT 증거](../phase-24/subscription-uat-2026-07-14.md)의
`not-run` 및 이전 network timeout 계보를 그대로 유지합니다.
