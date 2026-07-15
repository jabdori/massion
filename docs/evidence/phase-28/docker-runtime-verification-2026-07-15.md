# Phase 28 — Docker 이미지·런타임 검증 증거

> **검증일**: 2026-07-15
> **검증 source commit**: `ed10a4dad4e08906fbc489890f848db79e9f2ddc`

이 문서는 비밀값, 개인 경로, 원시 로그를 저장하지 않고 이미지 식별자와 검증 결과만 기록합니다. 검증에는 저장소에 없는 임시 Docker 이름·포트·볼륨을 사용했으며 종료 뒤 모두 제거했습니다.

## 이미지 검증

| 이미지 | 결과 |
|---|---|
| Massion production | 빌드·최종 unpack 성공; digest `sha256:81394cce603417fa40edc8ed3e64aeeec50cbc477657b83a7a26678b3b37ca48`, 크기 524447252 bytes |
| Caddy 정적 Web·reverse proxy | 저장소 루트 context에서 빌드·최종 unpack 성공; digest `sha256:4c58562e8652e93cb6e9cb2dcf8d82d8a6bd1f6b922a13ccffc1128c88ab7081`, 크기 23413998 bytes |

## 로컬 모드 컨테이너 smoke

로컬 모드는 보안상 loopback(`127.0.0.1`)에만 HTTP를 바인딩하므로 호스트 포트가 아닌 컨테이너 내부에서 확인했습니다.

| 확인 | 결과 |
|---|---|
| `/health/live` | HTTP 200, `{"status":"live"}` |
| `/health/ready` | HTTP 200; `connectors`, `database`, `migrations`, `runtime-recovery`, `server-connectors`, `subscription-quota` 모두 `ready` |
| 인증 없는 `/api/v1/status` | HTTP 401, `massion.error.v1` 인증 오류 봉투 |
| 정상 종료 | 컨테이너 exit code 0 |

첫 번째 호스트 포트 probe는 loopback 바인딩 계약을 위반한 테스트 구성으로 실패했습니다. 컨테이너 내부 probe로 같은 이미지를 재확인했으며 제품 실패로 분류하지 않았습니다.

## 범위

이 검증은 Docker 이미지·런타임 경계를 닫습니다. Claude 소비자 로그인, Z.AI Coding Plan, 복수 계정 rotation·quota·429·fallback과 같은 외부 제공자 UAT는 [Phase 24 계획](../../phases/24-native-subscription-connectors/implementation-plan.md)의 사용자 계정 조건으로 남아 있습니다.
