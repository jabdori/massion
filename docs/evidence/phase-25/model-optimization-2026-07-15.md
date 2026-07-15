# Phase 25 모델 최적화 실제 검증 — 2026-07-15

## 범위

- 검증된 소스 커밋: `70a21caf4cc817b4ab2a7d4283a9a1416c2844d0`
- 실행 방식: 현재 Massion 로컬 서버와 `tmux` 사용자 시나리오
- 연결 범위: 사용자가 승인한 OpenAI Codex 소비자 구독 profile 1개
- 비밀정보: 계정 식별자, profile handle, token, 원문 모델 응답은 이 문서에 기록하지 않습니다.

## 발견한 문제와 수정

기존 모델 평가 executor는 일반 언어 모델(`model`) lease만 허용하고 구독 Agent 실행기(`agent-runtime`)를 거부했습니다. 또한 평가 run을 구독 실행의 작업공간(workspace) 권한으로 연결하지 않았습니다.

다음 수정으로 해결했습니다.

1. 평가 실행기를 일반 모델과 구독 Agent 실행기의 공통 정산 경로로 분리했습니다.
2. 구독 Agent 결과의 완료 상태·실행 계보·토큰 사용량을 확인하고 동일한 route attempt를 완료 정산합니다.
3. 평가 run이 현재 조직에 속하는지 확인한 뒤 조직·run별 owner-only 작업공간을 발급합니다.
4. 작업공간 capability의 허용 도구 목록은 비워서 평가가 정본 변경이나 도구 호출을 시작하지 않도록 유지합니다.

## 검증 결과

| 단계 | 결과 |
| --- | --- |
| RED | 새 구독 Agent 평가 회귀 테스트가 구현 전 모듈 부재로 실패했습니다. |
| GREEN | 구독 Agent 실행기 정산 테스트, workspace 권한 테스트, 기존 로컬 모델 제품 테스트가 모두 통과했습니다(7 tests). |
| 서버 빌드 | `pnpm --filter @massion/server build` 종료 코드 0 |
| 전체 검증 | `pnpm verify` 종료 코드 0 (포맷, 전체 build, lint, typecheck, 전체 package test, 문서 구조 검증) |
| 보안 게이트 | `pnpm verify:security` 종료 코드 0, moderate/high/critical 0, low 1 |
| hardening | `pnpm verify:hardening` 종료 코드 0, 500 requests·concurrency 32·failures 0·clean shutdown |
| release | `pnpm release:build` 및 `CI=true pnpm verify:release` 종료 코드 0, backup restored·data preserved |
| tmux doctor | 시스템·로컬 DB·model runtime이 `ready`, 누락·차단 route 없음 |
| tmux subscription accounts | Codex connector가 `ready`, 직접 quota 관측값 존재, quota exhausted 아님 |
| tmux evaluation | `optimization.evaluation.execute` 성공, 표본 1개, 품질 점수 1, 비용 0, privacy 허용, 완료 true |
| 추천 | 실제 영수증으로 추천 생성 성공, 상태 `pending-approval` |
| 승인·배치 | 수동 거버넌스 결정으로 추천 승인 성공, `candidate` batch 생성 성공 |

## 아직 완료로 표시하지 않은 범위

- 현재 환경에서 실제 연결된 Provider는 Codex 하나뿐입니다. Claude 소비자 로그인과 Z.AI GLM Coding Plan은 제품 정책상 명시적 제공자 승인 전 실행하지 않습니다.
- 복수 계정의 실시간 회전, 429·offline fallback, 중단·재개는 별도 외부 계정/네트워크 시나리오가 필요합니다.
- 자동 최적화, shadow·limited·active 승격, degraded 관찰 rollback, 재시작 후 포인터 복구는 이 실행에서 호출하지 않았습니다. 자동화 기본값은 계속 꺼져 있으며, 수동 승인과 candidate 단계까지만 확인했습니다.
- Docker production image unpack은 Docker Desktop 저장소의 `input/output error`로 중단됐습니다. 검증 tag는 생성되지 않았고 공유 image·container·cache는 임의로 삭제하지 않았습니다. Docker 저장소 공간을 회수한 뒤 별도 배포 환경에서 재실행해야 합니다.
