# Phase 24 현재 source Codex 연결·프로필 재사용 증거 — 2026-07-15

> **범위**: 사용자가 제공한 Codex 계정으로 현재 source를 실행한 로컬·tmux 검증
> **민감정보**: OAuth URL, token, 이메일, profile handle, account·Connector ID, 원시 모델 응답은 저장하지 않음

## 기준점

- Source commit: `9240500879f5a357157b361d00def3ead201989d`
- 변경: 불완전한 성공 attestation 응답을 오래된 command ID로 영구 재생하지 않고, 직접 quota 증거가 없을 때 새 attestation command·correlation ID로 한 번 재시도
- 회귀 테스트: `apps/cli/src/subscription-login.test.ts`의 보류 attestation 회복 시나리오

## 실제 사용자 시나리오

검증은 실행 중인 로컬 Massion 서버(`127.0.0.1:7331`)와 CLI를 별도 `tmux` 세션에서 사용했습니다.

1. 소유자 초기화 뒤 `subscription connect openai-codex`를 실행하고 사용자가 Codex OAuth를 완료했습니다.
2. 첫 연결은 이전 서버 버전에서 저장된 불완전한 보류 attestation을 읽었습니다. 첫 replay에는 `status: ready`가 있었지만 `quotaObservation`이 없었습니다.
3. CLI가 새 command·correlation ID를 생성해 attestation을 한 번 재실행했고, 직접 quota 관측 증거를 받은 뒤 `status: ready`, `connectionDisposition: new`를 반환했습니다.
4. 보류 파일이 삭제된 뒤 같은 별칭으로 다시 연결했습니다. OAuth 흐름을 다시 열지 않고 `status: ready`, `connectionDisposition: reused`와 동일한 계정·Connector 계보를 반환했습니다.
5. `subscription accounts`, `subscription doctor`, `subscription quota`를 조회했습니다. Connector는 `ready`, 계정은 `active`, doctor 조치는 `none`, quota 상태는 `available`, 보고된 Codex quota window는 고갈되지 않은 상태였습니다.

## 실제 모델 실행

`mass run "현재 연결된 모델의 이름만 한 줄로 답해주세요." --json`을 실행했습니다.

- Application run은 `run.started`부터 `run.blocked`까지 정상적인 이벤트 계보를 남겼습니다.
- `representative`, `context-strategy`, `delivery-coordination`의 구독 Agent runtime 실행은 각각 `runtime.execution-succeeded`를 기록했습니다.
- 마지막 `assurance` 단계는 개인 로컬 기본 정책에 assurance binding이 없어 `run.blocked`로 종료되었습니다.
- 따라서 전체 Work를 완료했다고 기록하지 않으며, fallback·복수 계정 회전까지 성공했다고 확장하지 않습니다. 이번 결과는 실제 Codex 연결·quota·프로필 재사용·세 역할의 모델 호출 성공과 assurance 정책 차단을 함께 증명합니다.

`--jsonl`은 일반 run 결과가 아니라 stdin JSON Lines 입력 모드이므로, 첫 시도는 모델 실행으로 해석하지 않고 종료했습니다. 일반 `--json` 경로를 사용한 결과만 위 증거에 포함했습니다.

## 코드·검증 결과

- `pnpm --filter @massion/cli exec vitest run src/subscription-login.test.ts --maxWorkers=1`: 29 passed
- `pnpm --filter @massion/cli test`: 12 test files passed, 1 skipped; 107 passed, 1 skipped
- `pnpm --filter @massion/cli build`: exit 0
- `pnpm lint`: exit 0
- `pnpm typecheck`: exit 0

## 판정

현재 source에서 Codex OAuth 연결, 직접 quota 건강 증명, 기존 profile 재사용은 통과했습니다. 불완전한 성공 응답의 idempotent replay 문제는 `9240500`에서 회복 경로와 회귀 테스트로 수정했습니다. Claude·Z.AI, 복수 계정 rotation·fallback, assurance binding이 필요한 전체 Work 완료는 이번 단일 계정 검증으로 통과 처리하지 않습니다.

## 후속 CLI 실행 수명주기 수정

- Source commit: `d899cba`
- 원인: terminal event를 받은 뒤 SSE decoder가 reader lock만 해제하고 underlying stream을 취소하지 않아 `mass run` 프로세스가 출력 후에도 남을 수 있었습니다.
- TDD: 취소 callback을 확인하는 테스트를 먼저 RED로 재현했고, `reader.cancel()`을 추가한 뒤 Application SSE 4/4, Application 전체 165 passed·2 skipped를 통과했습니다.
- 실제 확인: 수정된 CLI build로 같은 Codex Work 요청을 `tmux`에서 실행해 `run.blocked` 결과를 받은 뒤 CLI·tmux 세션·child process가 남지 않음을 확인했습니다. assurance binding 미설정에 따른 `blocked` 판정 자체는 그대로 보존했습니다.
