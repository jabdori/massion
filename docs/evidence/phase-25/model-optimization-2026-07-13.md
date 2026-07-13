# Phase 25 모델 평가실 검증 증거

> **실행일**: 2026-07-13
> **검증 커밋**: `4a833fe19617e84139213a89c3fb1d0afa5c6afa`
> **범위**: 개인용 Core 저장소의 모델 평가·추천·배치·정책·Runtime 선호 순서

## 자동 검증 결과

- `pnpm verify`: 통과
  - 저장소 검증 테스트 67개 통과
  - 워크스페이스 패키지 테스트 통과
  - 문서 구조 검증 통과
- `pnpm verify:security`: 통과
  - 14개 test file, 67개 테스트 통과
  - moderate/high/critical 취약점 0개, low 1개
- `pnpm verify:hardening`: 통과
  - 26개 테스트 통과
  - hardening load 500 requests, concurrency 32, failures 0, p95 12.18ms
- `pnpm release:build`: 통과
  - release schema: `massion.release.v1`
  - source commit: `4a833fe19617e84139213a89c3fb1d0afa5c6afa`
  - source digest: `sha256:984a9cf28771f1fc1dc61a6af2f5ad5b20fcdf2567dcb5255f130d24e7690db1`
  - local archive: `sha256:23d7cefa13ad6b30a68f7c18e913d8ba426384db8c318881dd158ad2380799f3`
- `pnpm verify:release`: 통과
  - 개인 설치·실행·백업 복원·삭제 검증
  - 삭제 후 사용자 데이터와 백업 보존 확인

## 모델 평가실 기능 범위

- 평가 묶음(bundle), 실행(run), 점수 영수증(receipt), 정책(policy), 추천(recommendation), 배치(batch), 실사용 관찰(observation), 복구(recovery)를 tenant와 checksum 기준으로 격리합니다.
- 서버의 `ModelEvaluationExecutor`가 Router 모델 프로필을 선택하고 AI SDK로 prompt를 실행합니다.
- 평가 실행은 파일·메시지·배포·승인·조직 정본 변경 capability를 모두 `false`로 전달합니다.
- `production_learning` 동의가 없는 실사용 관찰은 거부합니다.
- 정책별 실사용 관찰 예산을 누적 검사하여 초과 기록을 거부하고, 보존 기간에 따른 만료 시각을 기록합니다.
- 관찰·배치·복구 명령은 command idempotency와 request hash를 검사하여 재전송을 안전하게 처리합니다.
- 활성 배치는 Runtime이 역할별 모델 선호 순서로 읽고 Router reserve 후보 순서에 반영합니다.
- Web 정책 화면은 owner/admin만 변경할 수 있고, governance decision id를 필수로 받습니다.
- 외부 평가 bundle은 version·license·configuration checksum·case role 계보를 검증한 뒤 Application/CLI import/export operation으로 이동합니다.
- Extension manifest는 선택적 `modelEvaluationBundles`를 역할 식별자·버전·SHA-256 체크섬·handler와 함께 검증하고, Extension host가 `modelEvaluationBundles:<id>` contribution을 worker 경계에 등록합니다. Core optimizer의 고정 role key 집합과 Extension worker의 외부 역할은 분리됩니다.

## tmux 실제 사용자 시나리오

이전 검증 local archive를 격리된 `massion-uat-phase24` tmux 세션에서 설치하여 실행했고, 이번 커밋의 새 local archive도 같은 설치 preflight까지 실행했습니다. 비밀값과 원시 pane 출력은 저장하지 않았습니다.

- `release-lifecycle`: passed
  - 설치, version, Connector doctor, local start, owner 초기화, readiness, provider catalog, event watch, 재시작, backup/restore, uninstall 후 data 보존
- `codex-live-subscription`: failed (`network`)
  - Codex 로그인 동의, accounts, doctor, quota, adaptive policy configure/query까지 통과
  - 실제 `run subscription acceptance`는 180초 timeout으로 종료되어 실행 계보와 성공으로 기록하지 않음
  - 브라우저 OAuth 인증 URL에서 사용자 계정 인증이 추가로 필요함
- 이번 새 archive tmux 재실행은 같은 Codex OAuth 로그인 화면(이메일 입력)에서 사용자 인증이 없어 중단했습니다. 새 영수증을 만들지 않았으며, 기존 구조화 영수증의 결과를 변경하지 않았습니다.
- 의도적으로 미실행한 시나리오 9개
  - 두 번째 계정, 두 번째 사용자, 공개 failure injection, 승인 checkpoint, quota contract, Claude/Z.AI 공개 Provider 승인 조건

원본 구조화 영수증은 로컬 `artifacts/uat-phase-24/receipt.json`에 생성되며, 저장소에는 민감정보 제거 요약만 보존합니다.

## 남은 완성 조건

Phase 25는 현재 in-progress입니다. Provider별 품질 분포와 자동 승격 운영 증거, 실제 TUI/import-export release 반복, 복수 계정·Provider UAT가 남아 있습니다. 확장 평가 묶음의 manifest 검증 및 worker registry 등록은 완료했습니다.
