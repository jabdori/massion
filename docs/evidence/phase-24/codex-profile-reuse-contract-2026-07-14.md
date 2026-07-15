# Phase 24 — Codex 기존 profile 재사용 계약 검증

> **기록 시각**: 2026-07-14
> **기록 갱신**: 2026-07-15
> **범위**: 개인용 local Massion의 `subscription connect openai-codex`
> **상태**: 변경 범위 자동화 검증 진행 중 · 현재 source commit의 최종 전수 검증과 실제 제공자 UAT 영수증은 대기

## 사용자 동작 계약

이미 연결된 Massion 관리 Codex profile이 있으면, `subscription connect`는 기존 계정·doctor·quota의 계보를 확인하고 profile 경로와 인증 자료의 안전성을 확인합니다. 이 경로는 계정 소유자로 확인된 사용자(`canManage: true`)만 사용할 수 있습니다. 같은 provider에 소유 계정과 조직 공유 계정이 함께 있어도 소유 계정만 재사용 후보로 계산하므로, 공유 계정이 후보 모호성을 만들지 않습니다. 조직에 공유받은 비소유 사용자는 profile 경로·인증 자료·로그인 process에 접근하기 전에 거부됩니다. profile의 인증 자료가 안전하게 존재하고 재인증 상태가 아니면 공식 Codex 로그인을 다시 열지 않습니다. Codex process를 시작하기 전에는 profile의 최종 경로뿐 아니라 상위 경로의 심볼릭 링크도 거부합니다.

연결이 완료되려면 건강 증명이 직접 quota 새로고침을 성공시키고, 공개 응답에 직접 관측 증거(`quotaObservation.source: "direct"`)를 포함해야 합니다. 이 새로고침은 계정별 모델 관측과 model profile·Core route candidate 저장보다 먼저 실행합니다. 따라서 새 계정의 직접 관측이 불가능하면 새 model profile·근거·route candidate를 만들지 않아 라우터가 그 미검증 계정을 선택할 수 없습니다. 새로고침이 인증 만료가 아닌 이유로 불가능하면 서버는 `ready`를 반환하지 않고 재시도 가능한 `APP_SUBSCRIPTION_QUOTA_UNAVAILABLE` 오류를 반환합니다. 이 경우 이미 검증되어 있던 연결을 재로그인 또는 Connector offline으로 전이하지 않습니다. CLI는 이 직접 관측 증거를 확인한 뒤 공개 quota projection도 다시 확인합니다. 공개 quota는 동일 계정의 `exhausted` boolean, 비어 있지 않은 `codex:` window, 허용된 신뢰도, 유효한 관측 시각을 가져야 하며, 그중 적어도 하나는 `reported` 신뢰도와 연결 이후 관측 시각을 가져야 합니다. `remainingRatio`는 선택값입니다. 값이 있으면 0~1 범위의 유한 숫자여야 하지만, 값이 없다는 이유만으로 연결을 거부하지 않습니다.

건강 증명은 `requireFresh: true`로 Codex quota를 직접 새로고침합니다. 이미 시작한 scheduler 관측이 있으면 그것을 연결 후 관측 근거로 재사용하지 않고, 끝난 뒤 새 provider 관측을 시작합니다. 같은 이전 관측을 기다린 직접 요청은 그 다음 한 번의 새 관측만 공유합니다. 따라서 연결 완료의 quota는 health 시작 뒤 생성된 관측입니다.

다음 경우에만 같은 profile에서 공식 로그인을 실행합니다.

- 관리 profile 또는 안전한 `auth.json`이 없음
- doctor가 재인증(`reauth`)을 지시함
- 계정 상태가 재인증 필요(`needs-reauth`)임
- 건강 증명이 구조화된 재인증 오류를 반환함
- 과거 keyring 또는 `auto` 방식으로 만들어져 안전한 격리 `auth.json`이 아직 없는 profile

[Codex app-server의 `account/read` 공식 계약](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#1-check-auth-state)에서 `requiresOpenaiAuth`는 현재 활성 provider가 OpenAI 인증을 요구하는지를 뜻합니다. 따라서 Massion은 `requiresOpenaiAuth: true`이면서 `account: null`인 경우에만 재인증으로 분류합니다. OpenAI 인증이 필요 없는 provider 상태, API key·Bedrock 등 ChatGPT가 아닌 계정 유형, ChatGPT 유료 plan을 확인할 수 없는 응답(누락·free·unknown·미래 plan 포함)은 로그인으로 해결하지 않습니다. 이 경우는 유료 소비자 구독을 증명할 수 없는 상태로 실패 폐쇄하고, 자동 로그인 UI를 열지 않습니다.

마지막 경우는 config 내용을 해석해 저장 방식을 추정하는 동작이 아니라, 안전한 격리 `auth.json` 부재를 복구하는 일회성 전환입니다. Massion은 운영체제 전역 keyring을 읽거나 다른 profile로 복사하지 않습니다. 대신 동일한 Massion 관리 profile에서 공식 Codex 로그인을 한 번 실행하고, 각 Massion 실행에 `file` 저장 방식 override를 전달해 owner-only `auth.json`을 만듭니다. 안전한 기존 `config.toml`은 덮어쓰지 않습니다. 파일이 없을 때만 owner-only 기본 설정을 만들고, 안전하지 않은 기존 파일은 실패 폐쇄합니다. 이후 모든 Codex process는 override를, SDK 경로는 동등한 SDK configuration을 사용합니다.

새 계정도 로그인 뒤 건강 증명이 재인증을 요구하면, 이미 배치한 동일 profile에서 한 번만 공식 로그인을 다시 실행합니다. 준비(prepare)와 건강 증명(attest)의 실패 command는 같은 actor와 완전히 같은 command envelope에서만 안전하게 재개할 수 있습니다. CLI는 pending 상태의 command ID와 correlation ID를 보존하며, 중단된 새 계정 추가를 재개할 때도 `--new-account`를 다시 요구합니다. 이 흐름은 응답 유실이나 일시 실패가 중단된 새 계정 추가를 영구히 잠그지 않게 합니다. 원자성 경계와 실제 저장소 검증은 `prepare-retry-atomicity-2026-07-15.md`에 분리해 기록합니다.

Codex 계정이 아직 하나도 없을 때의 첫 연결(`initial`)은 기본 명령으로 시작합니다. 이미 Codex 계정이 있을 때 두 번째 계정을 추가하려면 사용자가 `--new-account`를 명시해야 합니다. 기본 경로는 기존 profile 재사용만 시도하며, 별칭 불일치나 여러 계정의 모호함을 새 계정 생성으로 해석하지 않습니다.

이전 `v1` 재개 파일에는 새 계정 의도 필드가 없었습니다. 이 필드가 없는 과거 파일은 보수적으로 기존 연결(`initial`)로만 해석합니다. 따라서 업데이트 뒤에도 기존 연결은 재개할 수 있지만, 과거 상태를 새 계정 추가로 승격하지 않습니다.

Massion은 이 흐름에서 별도의 OpenAI 데이터 처리 동의 UI를 표시하거나 그 선택을 저장하지 않습니다. OpenAI 계정의 데이터 제어는 사용자가 OpenAI에서 직접 관리합니다.

## 제공자 호환성 근거

2026-07-15에 갱신 확인한 [Codex 공식 자격 증명 저장소 문서](https://learn.chatgpt.com/docs/auth#credential-storage)는 `file`이 `CODEX_HOME` 아래 `auth.json`을 사용하고, `keyring`·`auto`는 운영체제 credential store를 사용할 수 있다고 설명합니다. Massion은 여러 계정의 독립적인 profile 경계를 위해 지원되는 `file` 저장소를 계정별 owner-only profile에 한정합니다. 운영체제 전역 keyring은 읽거나 복사하지 않으며, 인증 파일은 password처럼 취급해 공개 query·로그·UAT 영수증에 포함하지 않습니다.

## 자동화 근거

다음은 변경 범위 검증과 전수 검증 기록입니다. 실제 제공자 계정의 OAuth·quota·실행 결과는 이 자동화 검증과 별도로 취급합니다.

### 2026-07-15 변경 범위 검증 기록

- `pnpm --filter @massion/cli exec vitest run src/subscription-login.test.ts --reporter=dot` — 26개 통과
- `pnpm --filter @massion/application exec vitest run src/subscription-server-commands.test.ts --reporter=dot` — 6개 통과
- `pnpm --filter @massion/server exec vitest run src/server-subscription-connection.test.ts src/subscription-quota-sync.test.ts --reporter=dot` — 29개 통과
- `node --test --test-concurrency=1 --test-name-pattern='Codex UAT는 최초 대화형 연결' scripts/uat-subscriptions.test.mjs` — 1개 통과

위 수치는 당시 작업 트리의 부분 실행 기록입니다. 이후 profile 후보 필터, app-server 인증 상태 분류, 직접 quota와 route 저장 순서가 변경되었으므로 현재 source의 최종 근거로 사용하지 않습니다. 특히 UAT fixture는 재연결 전 quota 조회를 종료 코드 95로 실패시키므로, `reused` 재연결 뒤에만 quota 관측을 수행하는 순서를 검증합니다.

### 최종 clean source commit 전수 검증 — 대기

2026-07-15에 격리 source snapshot에서 아래 명령의 종료 코드 0을 관측했지만, 그 snapshot의 Git commit·source digest·명령 로그 digest가 저장소에 함께 고정되지 않았습니다. 또한 이후 profile 재사용과 quota 경로가 변경되었습니다. 따라서 아래는 조사 이력일 뿐 현재 source의 통과 주장이나 release gate 근거가 아닙니다.

- `pnpm verify`
  - format, build, lint, typecheck, root·workspace test와 문서 구조 검증을 통과했습니다.
- `pnpm verify:security`
  - 14개 test file에서 67개 통과, 1개 skip이었고 moderate·high·critical 취약점은 0건이었습니다. low는 1건으로 기존 gate 기준을 통과했습니다.
- `pnpm verify:hardening`
  - 6개 test file, 26개 test를 통과했습니다. load 검증은 500 요청·동시성 32에서 실패 0, p95 11.84ms, clean shutdown이었습니다.
- `pnpm verify:architecture`
  - 아키텍처 다이어그램 11개를 검증했습니다.
- `pnpm verify:release`
  - 깨끗한 설치, connector doctor, local start, owner-only backup·restore, uninstall 뒤 data 보존을 통과했습니다. 결과는 `passed`, `limited`, `ready`, `restored`, `data-preserved`였습니다.

검증 중 발견한 두 환경 의존 fixture도 보강했습니다. UAT의 extensionless CommonJS executable은 상위 `type: "module"` 환경에서도 명시적 CommonJS 경계를 갖고 실행됩니다. non-Git revision fixture는 임시 경로가 상위 Git 저장소 안에 있어도 그 저장소 밖의 non-Git parent를 찾아 filesystem snapshot 계약을 검증합니다. 이 보강을 포함한 현재 source의 최종 전수 검증은 clean source commit을 만든 뒤 command log digest와 함께 새 evidence 문서로 고정합니다. 이 작업은 실제 Codex 계정 로그인·quota·모델 실행을 증명하지 않으므로, 아래 실제 사용자 UAT는 계속 필요합니다.

### 이전 종합 검증 기록

다음은 source commit·digest·명령 로그 digest를 현재 저장소에 결속하지 못한 과거 부분 실행 기록입니다. 현재 source의 통과 주장이 아니며, 이후 최종 receipt를 대체하지 않습니다.

- `pnpm --filter @massion/cli exec vitest run src/subscription-login.test.ts --reporter=dot` — 25개 통과
  - 기존 profile 재사용 시 로그인 미실행
  - 조직 공유 계정의 비소유 사용자는 profile 검사·로그인 전에 거부
  - 인증 자료 부재·명시적 재인증·건강 증명 재인증·이전 keyring profile의 일회성 격리 전환에만 로그인 실행
  - 새 계정의 건강 증명 재인증은 배치된 같은 profile에서 한 번 재로그인하고 같은 health command를 재개
  - 새 계정 prepare 응답의 일시 실패는 `--new-account`와 같은 command ID·correlation ID로 재개하며 로그인은 반복하지 않음
  - doctor Connector 계보 불일치와 깨진 quota 응답은 로그인·건강 증명 전에 실패 폐쇄
  - 빈 사전 quota는 로그인하지 않고 건강 증명 뒤 직접 관측 quota로 복구하며, 최종 `exhausted`와 존재하는 잔여 비율의 형식을 실패 폐쇄
  - `intent`가 없는 과거 재개 파일을 기존 연결로 안전하게 재개
  - profile 상위 경로가 외부를 가리키는 심볼릭 링크이면 config 쓰기·runtime 검사·로그인·건강 증명을 시작하지 않음
- `pnpm --filter @massion/cli exec vitest run src/commands.test.ts --reporter=verbose` — 18개 통과
  - JSON 출력에 연결 결과(`connectionDisposition`)가 보존됨
- `pnpm --filter @massion/application exec vitest run src/subscription-server-commands.test.ts --reporter=dot` — 5개 통과
  - 구조화된 재인증 오류로 실패한 `subscription.server.attest`가 동일 command ID로 재개됨
- `pnpm --filter @massion/runtime exec vitest run src/subscriptions/codex-profile.test.ts src/subscriptions/codex-connector.test.ts --reporter=dot` — 14개 통과
  - 안전한 기존 `config.toml` 보존, 실행별 file-store override, config·auth symlink/hard link 실패 폐쇄
- `pnpm --filter @massion/server exec vitest run src/subscription-profile.test.ts src/server-runtime-attestor.test.ts src/codex-subscription-observer.test.ts src/codex-app-server-agent.test.ts src/subscription-quota-sync.test.ts src/server-connector-startup-recovery.test.ts src/server-subscription-connection.test.ts --reporter=dot` — 68개 통과
  - 연결 직후 직접 quota 관측, 인증 만료만 재인증 전이, schema·upstream 불가 상태의 비재로그인 동작을 포함함
  - scheduler와 direct quota 관측의 경쟁 상태, 종료 중 새 관측 방지, quota 동기화 서비스 누락 시 ready 실패 폐쇄를 포함함
  - 실제 database·Application command registry에서 credential 생성 뒤 실패한 prepare가 account/provider/endpoint/credential/router audit을 rollback하고, offline Connector 하나만 남긴 뒤 같은 command generation 2에서 중복 없이 재개되는 것을 검증함
- `node --test --test-concurrency=1 --test-reporter=dot scripts/uat-subscriptions.test.mjs` — 종료 코드 0
  - 첫 연결 뒤 같은 별칭으로 비대화형 재연결
  - `reused`, 같은 account·Connector, provider 계정 수 1개
  - 연결 이후 직접 관측한 Codex quota
  - UAT 영수증·운영 로그에서 `auth.json`을 포함한 인증 자료 표식 차단

## 검증 실행 안정성

tmux와 실제 자식 process를 쓰는 UAT script는 root test script에서 `--test-concurrency=1`로 순차 실행합니다. CLI의 실제 child process E2E도 `--maxWorkers=1`로 실행합니다. 저장소의 자동 검증은 이 직렬 실행 정책이 설정됐는지를 확인합니다. 두 정책은 테스트 runner에만 적용되며, 제품의 agent·model·provider 동시 실행 정책은 변경하지 않습니다.

## 아직 필요한 실제 사용자 UAT

자동화 검증은 실제 Codex 계정의 OAuth·quota 값을 증명하지 않습니다. 격리 UAT 환경이 아니라 이미 Massion이 관리하는 profile이 있는, 사용자가 평소 사용하는 같은 local 환경에서 다음 한 번의 UAT가 남아 있습니다. `HOME`·`XDG_CONFIG_HOME`·`XDG_DATA_HOME`·`XDG_STATE_HOME`을 임시 경로로 바꾸거나 일반 `~/.codex`의 인증 파일을 복사하지 않습니다.

1. `mass local status --json`으로 local daemon 상태를 확인하고, 중지 상태면 `mass local start --json`을 실행합니다.
2. `mass subscription accounts --json`에서 `openai-codex` provider의 기존 `active`·`ready` server 계정, 별칭, 현재 사용자의 `canManage: true`를 확인합니다.
3. 그 별칭으로 `mass subscription connect openai-codex "<기존 별칭>" --json`을 실행합니다.
4. 출력이 같은 account·Connector와 `connectionDisposition: "reused"`인지 확인합니다.
5. `mass subscription doctor <accountId> --json`에서 `active`·`ready`·`none`을, `mass subscription quota <accountId> --json`에서 `codex:`·`reported`·현재 연결 이후 `observedAt`을 확인합니다.

브라우저 로그인이 뜨면 재사용 UAT의 성공은 아닙니다. profile/auth가 없거나 재인증 상태이거나, 이전 keyring/`auto` profile을 격리 file profile로 일회 전환할 때의 복구 흐름이며, 완료 결과는 `reauthenticated`여야 합니다. 이 문서는 실제 계정 식별자·인증 자료·개인 경로를 기록하지 않습니다.
