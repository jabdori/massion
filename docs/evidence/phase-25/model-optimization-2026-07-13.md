# Phase 25 모델 평가실 검증 증거

> **실행일**: 2026-07-13
> **검증 커밋**: `4a833fe19617e84139213a89c3fb1d0afa5c6afa`
> **범위**: 개인용 Core 저장소의 모델 평가·추천·배치·정책·Runtime 선호 순서

## 자동 검증 결과

2026-07-14 후속 검증에서는 모델 평가실 package 23개 테스트, Application 평가실 테스트 12개, CLI 16개, TUI 7개, Web 18개, 서버 모델 평가 제품 경계 테스트 1개를 다시 실행했습니다. 후보 batch의 우회 활성화와 shadow 동의 없는 batch 생성을 실패시키는 회귀 테스트를 추가했고, 두 테스트 모두 구현 수정 후 통과했습니다.

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
- 후보 batch는 표본·개선폭 승격 게이트 없이 활성화할 수 없고, shadow 동의가 없는 정책에서는 shadow batch를 만들 수 없습니다.

## tmux 실제 사용자 시나리오

이전 검증 local archive를 격리된 `massion-uat-phase24` tmux 세션에서 설치하여 실행했고, 이번 커밋의 새 local archive도 같은 설치 preflight까지 실행했습니다. 비밀값과 원시 pane 출력은 저장하지 않았습니다.

- `release-lifecycle`: passed
  - 설치, version, Connector doctor, local start, owner 초기화, readiness, provider catalog, event watch, 재시작, backup/restore, uninstall 후 data 보존
- `codex-live-subscription`: failed (`network`)
  - 공식 Codex CLI OAuth 인증, accounts, doctor, quota, adaptive policy configure/query까지 통과
  - Massion은 별도의 데이터 처리 고지·동의 UI를 표시하거나 그 선택을 기록하지 않음
  - 실제 `run subscription acceptance`는 180초 timeout으로 종료되어 실행 계보와 성공으로 기록하지 않음
  - 브라우저 OAuth 인증 URL에서 사용자 계정 인증이 추가로 필요함
- 2026-07-14 외부 Provider UAT 시도에서는 Codex OAuth 로그인과 계정 준비가 완료되었습니다. 실제 subscription run은 180초 네트워크 timeout으로 종료되었고, 결과는 구조화 영수증에 반영했습니다. 최신 local lifecycle 재검증에서는 외부 Provider 실행을 시작하지 않았습니다.
- 의도적으로 미실행한 시나리오 9개
  - 두 번째 계정, 두 번째 사용자, 공개 failure injection, 승인 checkpoint, quota contract, Claude/Z.AI 공개 Provider 승인 조건

원본 구조화 영수증은 로컬 `artifacts/uat-phase-24/receipt.json`에 생성되며, 저장소에는 민감정보 제거 요약만 보존합니다.

## 남은 완성 조건

Phase 25는 현재 in-progress입니다. Provider별 품질 분포와 자동 승격 운영 증거, 실제 TUI/import-export release 반복, 복수 계정·Provider UAT가 남아 있습니다. 확장 평가 묶음의 manifest 검증 및 worker registry 등록은 완료했습니다.

## 2026-07-14 코드 커밋 후속 검증 (`608b905`)

작업트리 정합성 검토 후 유효한 모델 평가실 변경만 포함한 코드 커밋 `608b905be3a407fe519eafd2a1f15c8d984e39e3`을 기준으로 다시 검증했습니다.

- `pnpm verify`: 통과
- `pnpm verify:security`: 통과 — 14개 test file, 67개 테스트 통과, moderate/high/critical 0개, low 1개
- `pnpm verify:hardening`: 통과 — 26개 테스트 통과, 500 requests, concurrency 32, failures 0, p95 13.03ms, shutdown clean
- `pnpm release:build`: 통과 — source digest `sha256:0bd24fa44cd55b9fc17319aa5f0054881f0ff5f923239356060afb90fe9111ee`, local archive `sha256:8775e3e503c9655ef0fc26da5b24a1c2a5d33d984009aa454e4d5516bf01e27c3`
- `pnpm verify:release`: 통과 — 공백이 없는 외장 볼륨 임시 경로를 사용하여 설치·실행·백업·복원·삭제·사용자 데이터 보존을 검증했습니다. 이는 제품 설정 변경이 아니라 macOS의 공백 포함 경로에서 RocksDB 네이티브 엔진이 초기화되지 않는 실행 환경 제약을 피하기 위한 검증 경로입니다.

이 검증 문서를 포함한 최종 문서 커밋 `09cbb84b18b1c7be14abfb1152fb38422ec34064`에서도 `pnpm release:build`와 `pnpm verify:release`를 다시 실행해 같은 설치·복원 경계를 통과시켰습니다.

이 후속 검증은 외부 Provider의 실제 품질 분포나 복수 계정 UAT를 대체하지 않습니다. 해당 시나리오는 외부 인증·네트워크·계정 상태가 필요하므로 Phase 25를 계속 `in-progress`로 유지합니다.

## 2026-07-14 최신 release·tmux lifecycle 재검증

- 검증 커밋: `584fdb72b78bf9f2451932af4028c2f0a123bb6a`
- Release source digest: `sha256:1a705c9545f54abe8ed806e85b424b5be04ca209f7e0809cca3a4171a7231157`
- Local archive digest: `sha256:a9bf059c11cdd50f2fda026170efdb6fa7e6ace00fdbd3f9f66565734ada6611`
- `pnpm verify:release`: 통과
- tmux UAT receipt digest: `sha256:4bad0bc7039f7060d888690f5c8e88efc1500817258c592420b74566f65a664a`
- receipt summary: `passed: 1`, `failed: 0`, `not-run: 9`

최신 release는 경로에 공백이 포함된 격리 작업공간에서 local lifecycle 설치·실행·재시작·backup·restore·uninstall data 보존을 통과했습니다. 이 결과는 모델 역할별 Provider 품질 평가를 통과했다는 뜻이 아닙니다. 실제 Provider run, 추천 승인·자동 승격·shadow·rollback의 release 영수증, TUI mutation·외부 bundle import/export 반복은 여전히 외부 Provider 인증·추가 계정·추가 사용자 또는 별도 release 시나리오가 필요합니다.

## 2026-07-14 최적화 회귀 수정 후 release tmux 시나리오

코드 검증 기준 커밋은 `e60811ab839ddcb13c09a2074b39a82c273aada1`입니다. 이 커밋은 SurrealDB transaction 조회 순서에 의존하던 batch·bundle version 계산을 전체 version 최댓값 기반으로 고정하고, 후보 batch 활성화 거부를 내부 오류가 아닌 구조화된 최적화 정책 오류로 반환합니다.

새 local archive를 격리된 `massion-opt-uat` tmux 세션에 설치하여 이미 구성된 로컬 OpenAI 호환 평가 Provider를 재사용했습니다. 원시 pane 출력·credential·token·식별자는 보존하지 않았습니다.

- 설치 후 `mass version`: `Massion AgentOS 1.0.0`
- 승인된 추천으로 batch version `3` 생성 성공(기존 version `1`, `2` 다음 계보 유지)
- candidate batch 활성화: exit `4`, 사용자 오류 `모델 최적화 정책이 요청을 거부했습니다`
- limited batch version `3` 활성화 성공
- production degraded observation 기록 및 `degraded-observation` recovery 성공(이전 active batch로 복구)
- 평가 bundle version `2`, `3` 생성 성공(기존 version `1` 다음 계보 유지)

이번 시나리오는 외부 Provider의 품질 분포를 증명하지 않습니다. 로컬 호환 Provider에서 평가실의 정책·버전 계보·승격·관찰·복구 경계를 검증한 결과이며, 실제 Claude·Codex·GLM 및 복수 구독 계정의 연결·quota·fallback 검증은 여전히 사용자 계정 인증과 네트워크가 필요합니다.

## 2026-07-14 TUI bundle 전송 허용 목록 보완

코드 커밋 `982bf57`에서 TUI의 최적화 변경 허용 목록에 `optimization.bundle.export`와 `optimization.bundle.import`를 추가했습니다. 이전에는 CLI와 Application operation이 지원하는 외부 평가 bundle 전송을 TUI JSON modal에서 거부하는 경로가 있었습니다.

- RED: TUI command test가 두 operation을 `허용되지 않은 최적화 operation`으로 거부하는 것을 확인
- GREEN: 허용 목록을 보완하고 export·import payload가 인증된 Application command로 전달되는지 검증
- 결과: TUI test file 7개, 테스트 52개 통과(1개 skip), Bun renderer 13개 통과

실제 최종 release에서 bundle export/import를 수행하는 증적은 다음 release tmux 시나리오에서 추가합니다. 외부 Provider 인증 여부와는 독립적인 제품 표면 검증입니다.
