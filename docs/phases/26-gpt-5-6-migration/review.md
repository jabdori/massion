# Phase 26 — GPT-5.6 모델군 호환성 이관 회고

> **상태**: completed — GPT-5.6 이관 범위 완료, 저장소 전체 출시 gate는 미통과
> **판정일**: 2026-07-12
> **설계**: `docs/phases/26-gpt-5-6-migration/design.md`
> **구현 계획**: `docs/phases/26-gpt-5-6-migration/implementation-plan.md`
> **상세 설계**: `docs/superpowers/specs/2026-07-12-gpt-5-6-migration-design.md`

## 1. 현재 사용 인벤토리와 대상 매핑

| 사람이 이해하는 책임 | 실제 사용 지점 | 확인한 동작 | 이관 판정 |
|---|---|---|---|
| 설치형 에이전트가 선택된 모델을 실제로 만드는 활성 실행 경로 | `packages/runtime/src/model-factory.ts` | OpenAI 형식 제공자를 모두 Chat Completions provider로 만들고 있었음 | 직접 OpenAI의 공식 GPT-5.6 네 ID만 Responses API로 이관 |
| 사용자가 등록한 모델·가격·기능·fallback의 운영 정본 | `model_profile.model_id`와 `packages/router` | 활성 기본 모델 문자열이 없고 운영 데이터가 모델 선택을 소유함 | 자동 추가·삭제·치환하지 않음 |
| Codex 구독을 실행하는 연결기 | `packages/runtime/src/subscriptions/codex-connector.ts` | 모델을 강제하지 않고 Codex profile·사용자 설정을 상속하며, 비테스트 제품 조립 지점은 아직 없음 | Phase 26에서 변경하지 않음 |
| 과거 설계 예시와 회귀용 모델 문자열 | Phase 3·4·7·8 문서와 테스트 fixture | 당시 설계와 추상 계약의 증거 | 역사·fixture를 최신 모델로 가장하지 않고 보존 |
| 타사·로컬 OpenAI 형식 제공자 | 사용자 지정 AI SDK endpoint, OpenAI-compatible gateway, Ollama | 각 제공자가 지원하는 Chat Completions 계약 사용 | `/responses` 지원을 추정하지 않고 기존 계약 보존 |

공식 문서에서 확인한 현재 family ID는 `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`입니다. `gpt-5.6` alias는 Sol로 연결되며 reasoning·tool·multi-turn 실행에는 Responses API가 권장됩니다. 근거는 [Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model)과 [Upgrading to GPT-5.6 Sol](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol)입니다.

## 2. 변경한 지점

`OpenAICompatibleModelBuilder`에 다음 세 조건을 모두 만족할 때만 Responses provider를 선택하는 좁은 분기를 추가했습니다.

1. 제공자 adapter 종류(`adapter_kind`)가 직접 AI SDK 경로인 `ai-sdk`입니다.
2. endpoint 문자열을 URL로 해석한 결과가 정확히 `https://api.openai.com/v1` 또는 단일 끝 슬래시를 붙인 주소입니다.
3. 모델 ID가 위 네 개의 명시적 허용 목록에 있습니다.

Responses 경로는 사용자 입력 주소를 다시 조합하지 않고 검증된 공식 base 상수로 `createOpenAI`를 만듭니다. 나머지는 기존 `provider.chat(modelId)` 경로를 유지합니다.

GPT-5.6 Responses model에는 AI SDK 기본 설정 middleware로 `providerOptions.openai.store=false`를 적용했습니다. [OpenAI 데이터 통제 문서](https://developers.openai.com/api/docs/guides/your-data#v1responses)에 따르면 Responses API는 기본값 또는 `store:true`에서 애플리케이션 상태를 최소 30일 보존합니다. Massion은 장기 상태를 자체 tenant 정본에 보존하므로 외부 Responses 상태 저장을 기본 요청하지 않습니다. 이 값은 애플리케이션 상태 저장을 끄는 것이며 기본 abuse monitoring 보존이나 계정의 Zero Data Retention 자격을 대신하지 않습니다.

실제 HTTP 계약 테스트는 `gpt-5.6-sol` 호출이 `https://api.openai.com/v1/responses`로 나가고 body에 `store:false`가 있으며 Responses 응답의 `output_text`를 `ok`로 해석하는지 확인합니다. 추가 경계 테스트는 빈 query·fragment, 이중 끝 슬래시, 사용자 지정 provider 식별자가 공식 경로로 잘못 분류되지 않는지 고정합니다.

## 3. 변경하지 않은 지점과 이유

- 현재 설치된 `@ai-sdk/openai@3.0.83`이 네 모델 ID와 Responses provider를 이미 지원하므로 package version과 `pnpm-lock.yaml`을 바꾸지 않았습니다.
- 운영 모델 정본은 사용자 데이터이므로 모델 registry, 가격, context limit, capability와 route 후보를 자동 생성하거나 교체하지 않았습니다.
- Codex 연결기는 아직 제품 실행 경로에 조립되지 않았고 모델 미지정이 사용자 `config.toml` 선택을 보존하므로 강제 model option을 추가하지 않았습니다.
- 기존 OpenAI 모델, 사용자 proxy, gateway, Ollama의 protocol과 fallback 순서를 바꾸지 않았습니다.
- 과거 문서·fixture·평가 baseline의 모델 문자열을 일괄 치환하지 않았습니다.
- 대표 평가에서 회귀를 관측하지 않았으므로 system·developer·agent prompt를 바꾸지 않았습니다.

## 4. 호환성 검사

| 입력 경계 | 기대 protocol | 실제 결과 |
|---|---|---|
| 공식 base + `gpt-5.6`·Sol·Terra·Luna | Responses | 통과 |
| 공식 base + 허용 목록 밖 `gpt-5.5` | Chat Completions | 통과 |
| 사용자 지정 `ai-sdk` proxy + `gpt-5.6-sol` | Chat Completions | 통과, 사용자 provider 식별자 보존 |
| OpenAI-compatible gateway + `gpt-5.6-sol` | Chat Completions | 통과, 사용자 provider 식별자 보존 |
| Ollama | `/v1/chat/completions` | 실제 로컬 HTTP server 계약 통과 |
| 공식 base + 빈 `?` 또는 `#` | Chat Completions | 모호한 문자열을 공식 endpoint로 승인하지 않음 |
| 공식 base + 이중 끝 슬래시 | Chat Completions | 비정규 주소를 승인하지 않음 |
| 공식 base + 단일 끝 슬래시 | Responses | 통과 |
| 공식 GPT-5.6 Responses request body | `store:false` | 통과 |

테스트 주도 개발(Test-Driven Development, TDD)에서 관측한 실패→성공 계보는 다음과 같습니다.

- Sol 계약: 새 테스트가 기존 Chat parser에서 실패하고 기존 4개는 통과한 뒤, 최소 분기에서 5/5 통과했습니다 (`fe2e23a`).
- 모호한 endpoint: 빈 query·fragment 2개가 실패하고 기존 5개는 통과한 뒤, 정확한 주소 판별로 7/7 통과했습니다 (`08b333d`).
- 전체 family: alias·Terra·Luna 3개가 실패하고 기존 7개는 통과한 뒤, 명시적 네 ID 허용 목록으로 확장했습니다 (`b26fc5f`).
- 사용자 provider 소유권: 두 사용자 endpoint case가 `openai.chat`으로 잘못 기대되도록 작성된 테스트 결함을 RED 2개로 드러낸 뒤 `configured-provider.chat` 계약으로 교정했고 15/15 통과했습니다 (`661b9ea`). Production 코드는 이 교정에서 바꾸지 않았습니다.
- Responses 저장 기본값: 기존 14개는 통과하고 request body의 `store`가 `undefined`라 새 assertion 1개가 실패한 뒤, GPT-5.6 Responses model에만 `store:false`를 적용해 15/15 통과했습니다 (`8dbf7c4`).

## 5. Prompt 변경 판정

Prompt 변경은 0건입니다. [GPT-5.6 Sol prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6)는 기존 prompt와 추론 설정으로 대표 평가를 먼저 실행하고 실제 회귀가 관측된 지점만 최소 수정하도록 안내합니다. 이번 단계에는 품질 비교용 실제 자격 증명과 Phase 25 평가 결과가 없으므로 prompt 변경 근거도 없습니다.

## 6. 검증 명령과 실제 결과

고정 실행 환경은 Node.js 24.18.0, Bun 1.3.14, pnpm 10.30.3입니다.

| 검증 명령 | 실제 결과 |
|---|---|
| `pnpm --filter @massion/runtime exec vitest run src/model-factory.test.ts` | 테스트 파일 1개, 테스트 15개 통과 |
| `pnpm --filter @massion/runtime test` | 테스트 파일 18개 통과·1개 조건부 생략, 테스트 66개 통과·1개 조건부 생략 |
| `pnpm --filter @massion/runtime typecheck` | 종료 코드 0 |
| `pnpm verify:docs` | 종료 코드 0 |
| `pnpm verify` | format은 통과했으나 lint 오류 13개로 종료 코드 1; 뒤의 전체 typecheck·test·build는 실행되지 않음 |
| `pnpm verify:security` | 보안 회귀 테스트 13개와 테스트 66개 통과·1개 생략 후 production audit에서 종료 코드 1 |
| `pnpm audit --prod --json` | low 3, moderate 8, high 16, critical 2로 총 29개 권고 확인 |
| `git diff --check` | 종료 코드 0 |

전체 lint 오류 13개 중 12개는 Phase 26 직전 구독 연결기 커밋 `a93b0ef`의 `connector-channel`, `connector-supervision`, `claude-connector`, `codex-connector`, `broker` 파일에 있습니다. 나머지 1개는 Phase 24의 미커밋 `acp-connector.ts`에 있습니다. `42332e1..8dbf7c4`의 Phase 26 코드 변경은 `model-factory.ts`와 그 테스트뿐이며 이 두 파일의 표적 lint·format 검사는 통과합니다.

Production audit 권고 29개 중 28개는 Phase 24 작업트리에 미커밋으로 추가된 `@google/gemini-cli-core@0.50.0` 전이 의존성 경로이고, 1개 low 권고는 기존 `@voltagent/core`의 `@ai-sdk/provider-utils` 경로입니다. Phase 26은 `package.json`과 lockfile을 변경하지 않았습니다. 따라서 이관 기능의 원인과는 분리되지만, 저장소 전체 출시 gate가 실패했다는 사실은 그대로 유지합니다.

## 7. 실제 자격 증명과 외부 gate

- `OPENAI_API_KEY`는 존재하지 않았습니다. 격리 fetch 계약을 실제 OpenAI API 성공으로 표현하지 않습니다.
- Codex CLI는 `0.144.1`, tmux는 `3.6a`였습니다.
- 현재 로그인된 Codex 구독으로 임시 폴더, 읽기 전용 sandbox, 일회성 session, `gpt-5.6-sol`을 지정한 무부작용 요청을 tmux에서 실행했습니다. thread는 시작됐지만 응답 전에 계정 사용량 한도에 도달해 turn이 실패했고 현지 시각 20:36 이후 재시도 안내를 받았습니다.
- 이 결과는 GPT-5.6 live 추론 성공도, Massion 제품 연결기 종단간(E2E) 성공도 아닙니다. 제품 연결기는 아직 서버에 조립되지 않았고 외부 사용량 gate도 닫혀 있습니다.

비밀 값, 계정 식별자, thread 식별자와 prompt 원문은 문서에 저장하지 않았습니다.

## 8. 요구사항과 커밋 계보

- `REQ-GPT56-001`: `fe2e23a`, `08b333d`, `b26fc5f`, `661b9ea`, `8dbf7c4`
- `REQ-GPT56-002`: `6bf0473`, `d07e530`, `b26fc5f`, `661b9ea`
- `REQ-GPT56-003`: `e57b504`, `6bf0473`, `d07e530`, `42332e1`

설계 정본은 `e57b504`에서 시작해 범위 축소와 endpoint 위협 경계를 `6bf0473`, `d07e530`에서 보강했고, 실행 가능한 TDD 계획은 `42332e1`에 고정했습니다. 구현과 검토 교정은 위 코드 커밋들에 분리했습니다. 전체 행은 `docs/generated/requirements-traceability.tsv`에 연결합니다.

## 9. 남은 위험과 후속 범위

Phase 26 변경 자체에서 확인된 미해결 CRITICAL·MAJOR finding은 없습니다. 다만 현재 작업트리를 전체 제품 출시 가능 상태로 판정할 수는 없습니다.

1. Phase 24는 위 lint 13개와 Gemini CLI 전이 의존성 보안 권고를 해결하고, 구독 연결기를 설치형 서버의 provider·계정 순환 경로에 조립해야 합니다.
2. Codex 사용량이 복구된 뒤 같은 읽기 전용 시나리오를 재실행하고, Phase 24 제품 조립 뒤에는 Massion을 통한 실제 thread 생성·재개·계정 fallback 영수증을 별도로 남겨야 합니다.
3. 역할별 Sol·Terra·Luna 배치는 추측으로 정하지 않고 Phase 25의 평가 묶음·품질·비용·지연 결과로 결정해야 합니다.
4. OpenAI `safety_identifier`는 조직별 안정적 가명 식별자를 전달할 별도 API surface와 개인정보 설계가 필요하므로 이번 endpoint 이관에서 임의 값을 만들지 않았습니다. `store:false`는 완료했지만 abuse monitoring과 Zero Data Retention은 제공자 계정 정책으로 별도 안내해야 합니다.
5. 모든 선행 요구사항을 완료한 뒤의 history-free Core 저장소와 별도 Cloud 사업 저장소 분리는 독립 Phase에서 import manifest·라이선스·비밀 검사·의존 방향을 검증해야 합니다.

따라서 판정은 “GPT-5.6 API 호환성 이관 완료”이며 “Massion 전체 제품화 완료”가 아닙니다.
