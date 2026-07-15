# Phase 24 — 네이티브 구독 연결기와 실제 사용자 인수 검증 구현 계획

> **상태**: in-progress
> **상세 계획**: [design.md](design.md)
> **방법**: 각 항목에서 실패 테스트 확인→최소 구현→관련 회귀 검증→커밋 순서를 지킵니다.

## Task 1. 구독 계정 정본

- [x] `@massion/subscriptions` package와 append-only migration을 추가합니다.
- [x] 개인·조직 scope, 공유 동의·철회, connector와 quota snapshot 원장을 TDD로 구현합니다.
- [x] secret·이메일·외부 account ID가 공개 query·event·metric에 나오지 않게 검증합니다.

## Task 2. 할당량 기반 라우팅

- [x] ProviderCredential을 암호화 비밀 또는 연결기 세션 union으로 확장합니다.
- [x] 복수 quota window와 `adaptive` 선택을 RED→GREEN으로 구현합니다.
- [x] 출력 전·후 실패, cooldown, reset, stale snapshot과 cross-provider fallback을 검증합니다.

## Task 3. 서버·사용자 기기 연결기

- [x] 연결기 protocol, 등록, 장치 서명, heartbeat, lease와 replay 방지를 구현합니다.
- [x] 서버 연결기의 계정별 profile·process 격리와 사용자 기기 offline·reconnect를 검증합니다.
- [x] Governance approval과 runtime suspend·resume을 연결합니다.

## Task 4. 공식 제공자 연결기

- [x] Codex SDK·app-server와 Claude Agent SDK 연결기를 구현합니다.
- [x] Claude 선택형 사람 승인은 Agent SDK `0.3.207`의 공식 `PreToolUse defer`·`deferred_tool_use`·`--resume` 왕복으로 구현하고, 원 session·도구 호출·입력 digest·승인 ID 불일치와 거부·취소·process 재시작을 실패 폐쇄합니다.
- [x] Codex의 유료 `planType`, `account/rateLimits/read`, 계정별 `model/list`를 하나의 고정 runtime 경로로 검증하고 요청 모델 또는 결정론적 GPT-5.6 기본 모델을 선택합니다.
- [x] Codex 모델의 runtime 가용성·OpenAI 공식 능력·bundled runtime artifact를 append-only 라우터 근거로 분리하고, 계정별 모델 근거가 없는 credential을 선택하지 않게 합니다.
- [x] Codex app-server의 명령·파일 승인 서버 요청을 같은 JSON-RPC 요청에 응답하는 Governance `review` 경로로 구현하고, 서버는 `automatic`·`review`·`deny`, Edge는 `automatic`·`deny`만 공개합니다. `review` 정책에서는 라우터가 Edge credential을 후보에서 제외합니다.
- [x] Gemini Enterprise·Copilot·xAI Grok Build ACP를 명시적 실험 동의가 필요한 사용자 기기 전용(edge-only) 표면으로 구현합니다. Google Antigravity는 상위 CLI의 one-shot·모델 목록 기능과 별개로 요청별 승인·인증 상태·계정 격리 계약이 부족해 공개 연결을 `unavailable`로 유지합니다. 상세 근거는 `provider-surface-review.md`에 남깁니다.
- [x] MiniMax Token Plan, xAI API, Nous Portal의 공식 인증·과금 manifest와 GLM·Kimi·StepFun·Alibaba·OpenCode Go·Kilo preset·capability probe를 구현합니다. Z.AI는 승인 전 비활성, Alibaba는 대화형 범위, StepFun은 quota 우회 금지, Kilo는 유료 Gateway로 제한합니다.
- [x] 2026-04-15 종료된 Qwen OAuth와 공개 계약이 없는 범용 OAuth 모델 연결기(`OAuthModelConnector`)를 제품 범위에서 제거합니다.

## Task 5. Application과 사용자 화면

- [x] 구독 provider·account·quota·policy·doctor query와 connect·share·unshare·disconnect·connector 폐기 command를 추가합니다.
- [x] CLI의 `mass subscription connect`는 기존 server Codex 계정의 profile·doctor·quota를 먼저 확인해 유효한 profile을 재사용합니다. 이 경로는 계정 소유자로 확인된 `canManage: true` 사용자만 후보로 계산하므로, 소유 계정과 공유 계정이 함께 있어도 공유 계정이 모호성을 만들지 않습니다. 공유받은 비소유자는 profile 검사·로그인 전에 거부합니다. doctor의 provider·별칭·계정·Connector 계보와 quota 형식을 실패 폐쇄로 검증하고, 건강 증명이 직접 quota를 새로고침해 공개 증거(`quotaObservation.source: "direct"`)를 반환할 때만 ready를 반환합니다. 직접 quota 관측은 model profile·Core route candidate 저장보다 먼저 수행하므로, 새 계정에서 관측이 불가능하면 라우터에 선택 가능한 모델 경로를 만들지 않습니다. 이 경우 `ready` 대신 재시도 가능한 unavailable 오류를 반환하며, 이미 검증된 연결을 재로그인·offline으로 전이하지 않습니다. CLI는 이어서 동일 계정의 `exhausted`, 유효한 `codex:` window와 health 이후 `reported` window를 확인합니다. `remainingRatio`는 선택값이고 존재할 때만 0~1 유한 수인지 검증합니다. 재인증은 Codex app-server가 `requiresOpenaiAuth: true`와 `account: null`을 함께 보고한 경우에만 해당 profile에서 실행합니다. OpenAI 인증이 필요 없는 provider, API key·Bedrock 등 ChatGPT가 아닌 계정, 누락·free·unknown·미확인 plan은 유료 소비자 구독 불가로 실패 폐쇄하며 로그인 UI를 열지 않습니다. 과거 keyring/`auto` 방식으로 안전한 owner-only `auth.json`이 없는 profile은 전역 keyring을 읽지 않고 같은 profile의 일회성 Massion file-store override 로그인으로 처리합니다. 안전한 기존 `config.toml`은 보존하고, 파일이 없을 때만 기본 설정을 만듭니다. Codex 계정이 없을 때의 첫 연결은 기본 명령으로 시작하고, 이미 계정이 있을 때 추가 계정은 `--new-account`를 명시해야 합니다. prepare·health의 일시 실패는 같은 actor와 완전히 같은 command envelope에서만 안전하게 재개합니다. 과거 `v1` 재개 파일에서 누락된 의도는 기존 연결로만 해석하고, profile 상위 경로의 심볼릭 링크는 config 쓰기·로그인 전에 거부합니다. JSON에는 `connectionDisposition`을 반환합니다. Massion의 별도 데이터 처리 고지·동의 UI는 추가하지 않습니다.
- [x] TUI·Web에서 같은 Application operation과 redacted view, 승인 미리보기를 제공합니다.

## Task 6. 제품 조립과 실제 사용자 검증

- [x] 배포 하위 작업으로 Caddy의 정확한 `/connectors` WebSocket 경로, Compose·Kustomize의 팀 수신 기본값, 로컬의 소유자 전용 profile root와 명시적 수신 선택을 정적 테스트·구성 해석으로 검증합니다.
- [x] Codex prepare→유료 인증→모델 발견→Core route→`MassionModelFactory` agent-runtime session lease를 실제 저장소 통합 테스트로 완주합니다.
- [x] 설치형 서버·로컬 lifecycle에 connector broker, runtime startup recovery, drain shutdown을 조립하고 product test로 검증합니다. team deploy의 실제 사용자 시나리오는 다음 항목에서 검증합니다.
- [x] 과거 release 기준으로 깨끗한 release 설치를 `tmux`에서 실행하고 local lifecycle과 공식 허용 범위의 실제 계정 시나리오를 검증했습니다. 이 기록은 `docs/evidence/phase-24/subscription-uat-2026-07-14.md`에 보존합니다. 이 receipt는 이전 release에 결속된 역사적 UAT이며 현재 source의 통과 증거가 아닙니다. Claude 소비자 로그인과 Z.AI는 제공자 승인 전 `provider-approval-required`로 검증합니다.
- [x] 재사용 UAT 계약은 첫 연결 뒤 같은 alias의 비대화형 재연결에서 `reused`·같은 account/Connector·provider 계정 1개·연결 이후 직접 관측 Codex quota를 요구합니다. 자동화 근거는 `docs/evidence/phase-24/codex-profile-reuse-contract-2026-07-14.md`입니다.
- [x] 새 Codex 계정 prepare의 credential 생성 뒤 실패는 실제 database·Application command registry에서 account/provider/endpoint/credential rollback, offline Connector 보상, 동일 command generation 2 재개, 세 번째 replay 무변화까지 검증합니다. 이는 전역 원자 transaction이 아닌 보상 saga이며, 근거는 `docs/evidence/phase-24/prepare-retry-atomicity-2026-07-15.md`입니다.
- [ ] 복수 계정 회전·quota·offline·429·fallback·중단·재개를 검증합니다. 실제 local restart와 owner-only backup·restore는 위 release lifecycle에서 통과했습니다.
- [ ] 현재 source의 기존 profile 재사용 실제 UAT를 사용자 local 환경에서 실행합니다. 기존 Massion 관리 profile을 재사용해 `connectionDisposition: "reused"`, 같은 account·Connector, 직접 quota 관측을 확인하고, 재로그인 UI가 열리지 않은 결과를 source commit·release artifact와 함께 receipt로 고정합니다.
- [x] 전체 검증, 요구사항 추적표, 아키텍처와 운영 문서의 로컬 결과를 검증된 source commit에 고정합니다. Phase 28의 `pnpm verify`, security, hardening, architecture, release와 clean clone 결과를 `docs/evidence/phase-28/pnpm-11-toolchain-verification-2026-07-15.md`에 결속했습니다. 실제 사용자 계정 UAT와 외부 Provider release gate는 다음 미완료 항목으로 유지합니다.
- [ ] 외부 계정 전제조건이 충족되면 복수 계정 UAT와 함께 Phase 24 최종 회고를 닫습니다.

## Task 7. Phase 24 기준점 닫기

- [x] 서버 종료에서 HTTP 수신 차단 뒤 실행 중 runtime을 취소·정산하고 connector·Application·Database를 닫는 순서를 TDD로 고정합니다.
- [x] ACP 초기화 중 취소와 출력 누적 상한을 fail-closed로 구현합니다.
- [x] Edge Connector 폐기 시 공개 명령이 현재 채널을 즉시 닫고 신규 RPC를 막는 경로를 검증합니다.
- [x] 개인 Codex 로그인에서 Massion의 데이터 처리 고지·동의 기록 API가 호출·등록되지 않음을 검증하고, 기존 설치의 불필요한 고지 기록 table도 migration으로 제거합니다. OpenAI 계정 데이터 제어는 제공자 공식 설정에 맡깁니다.
- [ ] 실제 사용자 자격 증명·tmux 시나리오와 외부 Provider release gate를 완료한 하나의 source commit으로 고정합니다.
