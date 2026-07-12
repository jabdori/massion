# Phase 24 — 외부 Agent 실행 표면 검수 기록

> **검수일**: 2026-07-12, Codex·Claude 승인 재개 보강 2026-07-13
> **상태**: 구현·정적 검증 완료, 실제 공급자 계정 UAT 대기
> **범위**: OpenAI Codex app-server, Anthropic Claude Agent SDK, Gemini CLI Enterprise, GitHub Copilot CLI, xAI Grok Build, Google Antigravity CLI

## 1. 결론

Gemini CLI Enterprise, GitHub Copilot CLI, xAI Grok Build는 사용자의 기기에서 실행하는 실험적 연결 표면(experimental Edge connection surface)으로 구현했습니다. 세 공급자를 `supported`로 표시하지 않습니다. 공식 CLI 계약이 아직 바뀔 수 있고, 실제 공급자 계정으로 릴리스 산출물을 검증하지 않았기 때문입니다.

Google Antigravity CLI는 상위 제품에 비대화식 실행, 모델 선택, 모델 목록, sandbox 기능이 있지만 Massion이 안전하게 연결하는 데 필요한 요청별 권한 전달(permission transport), 기계 판독 가능한 인증 상태 확인(auth health), 독립 계정 profile 계약이 확인되지 않았습니다. 따라서 공개 연결 위치(connection surface)는 `unavailable`로 유지합니다. `--dangerously-skip-permissions`는 Massion 승인 정책을 우회하므로 사용하지 않습니다.

OpenAI Codex 서버 runtime은 공식 app-server JSON-RPC 승인 요청으로 `automatic`, `review`, `deny`를 구현했습니다. 명령 실행과 파일 변경 승인은 보류 중인 같은 서버 요청에 Governance 결정을 응답하며, 취소는 같은 turn을 중단합니다. Codex Edge 연결에는 이 영속 승인 전달이 없으므로 `automatic`, `deny`만 제공합니다. Provider 정책이 `review`이면 Edge 계정을 라우팅 후보에서 제외하고 서버 계정만 선택합니다.

Claude Agent SDK 서버 runtime은 공식 지연 도구 호출(deferred tool use) 계약으로 `automatic`, `review`, `deny`를 모두 구현했습니다. 다만 이 구현은 실행 중 도구 승인 transport의 완성도를 뜻할 뿐, Anthropic 소비자 로그인을 Massion에서 사용할 수 있다는 뜻이 아닙니다. 소비자 로그인 연결은 제공자 사전 승인 전까지 `requires-provider-approval`로 차단합니다.

| 공급자 | 공개 상태 | 실행 위치 | Massion 모델 선택 | 계정 격리 | 승인 정책 |
|---|---|---|---|---|---|
| OpenAI Codex | supported | 서버·사용자 기기 표면 | 계정별 app-server `model/list` | `CODEX_HOME` profile root | 서버: automatic, review, deny / Edge: automatic, deny |
| Anthropic Claude Agent | requires-provider-approval | 서버·사용자 기기 표면 | 연결 시 명시 모델 | `CLAUDE_CONFIG_DIR` profile root | automatic, review, deny |
| Gemini CLI Enterprise | experimental | 사용자 기기(edge-only) | 명시적 `--model` | `GEMINI_CLI_HOME` | automatic, deny |
| GitHub Copilot CLI | experimental | 사용자 기기(edge-only) | ACP session의 표준 모델 설정 | OS credential store 기준 connector당 1계정 | automatic, deny |
| xAI Grok Build | experimental | 사용자 기기(edge-only) | 명시적 `--model`; 상위 CLI는 `grok models` 제공 | `GROK_HOME` | automatic, deny |
| Google Antigravity CLI | 연결 불가 | 없음 | Massion에서는 미구현 | 단일 OS keyring 계정만 가정 | 미지원 |

사용자 기기 기반 Edge ACP에는 `review` 승인을 아직 제공하지 않습니다. 현재 Edge ACP 실행을 중단하고 승인함에서 재개하는 영속 승인 전달(persistent approval transport)이 없으므로, 이 세 공급자의 `review` 정책은 실행 전에 실패 폐쇄(fail-closed)합니다. Claude Agent SDK 서버 runtime의 `review`는 아래 2.5절의 별도 공식 transport를 사용합니다.

Codex는 서버와 Edge를 모두 공개하므로 Provider 공통 승인 목록만으로 능력을 표현하지 않습니다. 공통 목록은 하위 호환 client가 안전하게 해석할 수 있는 교집합인 `automatic`, `deny`이고, 표면별 목록에서만 서버의 `review`를 추가합니다. Web·TUI·CLI는 연결된 계정 위치를 기준으로 선택지를 만들며 라우터도 같은 표면 계약을 강제합니다.

## 2. 최신 공식 계약 근거

### 2.1 Gemini CLI Enterprise

- Google의 [ACP mode 문서](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)는 `gemini --acp`, `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, 권한 모드, 모델 전환, 파일 시스템 proxy를 명시합니다.
- Google의 [CLI 설정 문서](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)는 사용자 설정과 저장소의 기준 위치를 바꾸는 `GEMINI_CLI_HOME`을 명시합니다.
- Google의 [CLI 인자 문서](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)는 `--model`과 `--acp`의 현재·호환 인자를 설명합니다. 실제 최신 [인자 정의 소스](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)에서는 `--acp`가 정식 인자이고 `--experimental-acp`가 호환용 deprecated 인자입니다.
- 최신 Gemini CLI는 ACP SDK 0.16.1의 확장 `models` 응답과 `unstable_setSessionModel`을 사용하지만, Massion은 ACP SDK 1.2.1의 표준 설정 계약을 사용합니다. 서로 다른 확장 필드를 지원한다고 추측하지 않고 실행 시 `--model`을 명시합니다. 그래서 Massion의 자동 모델 발견(model discovery)은 `none`입니다.

### 2.2 GitHub Copilot CLI

- GitHub의 [Copilot ACP server 문서](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)는 `copilot --acp --stdio`, ACP session, 출력 chunk, 권한 요청을 명시하며 이 기능을 public preview로 표시합니다.
- GitHub의 [인증 문서](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)는 기본 인증이 OS credential store를 사용하고, credential store가 없을 때만 평문 설정 파일로 내려간다고 설명합니다.
- GitHub의 [CLI 명령 문서](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)는 `COPILOT_HOME`이 설정 파일 위치를 바꾸지만 환경 변수 token이 우선한다고 명시합니다. Massion은 `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`을 자식 process에 전달하지 않습니다.
- 따라서 `COPILOT_HOME`만으로 여러 OS keyring 계정이 완전히 격리된다고 주장하지 않습니다. 같은 OS 사용자에서는 connector당 활성 credential-store 계정 하나만 지원합니다.

### 2.3 xAI Grok Build

- xAI의 [Headless & Scripting 문서](https://docs.x.ai/build/cli/headless-scripting)는 `grok agent stdio`, ACP JSON-RPC, `--no-auto-update`, `--model`, session update chunk를 명시합니다.
- xAI의 [CLI Reference](https://docs.x.ai/build/cli/reference)는 `grok models`, `grok version`, `grok agent stdio`를 명시합니다.
- xAI의 [Settings 문서](https://docs.x.ai/build/settings)는 설정 root를 바꾸는 `GROK_HOME`을 명시합니다. 기존 설계의 일반 `HOME` 격리 주장은 폐기했습니다.
- Massion은 소비자 구독의 cached login profile만 이 Edge 표면에 사용합니다. `XAI_API_KEY`를 ambient 환경에서 전달하지 않으며, API key 실행은 별도 `xai-api` 모델 공급자 경계입니다.

### 2.4 Google Antigravity CLI

- Google의 [Antigravity CLI 공식 저장소](https://github.com/google-antigravity/antigravity-cli)는 CLI가 system keyring으로 인증하고 권한을 받아 파일 수정·명령 실행을 수행한다고 명시하며 [공식 CLI 문서](https://antigravity.google/docs/cli-overview)를 연결합니다.
- Google의 [Antigravity CLI Codelab](https://codelabs.developers.google.com/antigravity-cli-hands-on)은 `agy --print`, `agy models`, `--model`, `--sandbox`, 네 가지 대화형 도구 권한 모드를 설명합니다.
- 같은 문서는 인증과 workspace 신뢰, 도구 권한 검토가 대화형 화면에서 이루어짐을 보여줍니다. 현재 공식 자료에서는 Massion이 각 도구 요청을 받아 조직의 `automatic/review/deny` 결정으로 응답하는 protocol, token을 읽지 않고 인증 상태만 확인하는 명령, 계정별 독립 profile root가 확인되지 않습니다.
- 저장소에는 기존 one-shot process adapter가 있지만 공개 enrollment와 제품 지원 표면에는 연결하지 않습니다. 안전 계약이 추가되면 별도 TDD와 실제 계정 UAT를 거쳐 승격합니다.

### 2.5 Anthropic Claude Agent SDK

- 공식 [Claude Code hook reference](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)는 비대화식 실행에서 `PreToolUse`가 `permissionDecision: "defer"`를 반환하면 도구를 실행하지 않고 `stop_reason: "tool_deferred"`와 `deferred_tool_use`를 남기며, `--resume`에서 같은 도구 호출을 다시 평가한다고 명시합니다. 이 기능은 Claude Code 2.1.89 이상에서 지원됩니다.
- 공식 [Agent SDK hook 문서](https://code.claude.com/docs/en/agent-sdk/hooks)는 callback hook의 `allow`, `deny`, `ask`, `defer` 결정과 deny → defer → ask → allow 우선순위를 명시합니다.
- 공식 [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)는 2.1.89에서 headless session의 `PreToolUse defer`와 `-p --resume` 재평가를 추가했고, 같은 버전에서 큰 입력과 표식 누락 시 resume 정지 문제를 수정했다고 기록합니다.
- Massion은 `@anthropic-ai/claude-agent-sdk` 0.3.207과 그 패키지가 번들한 Claude Code 2.1.207을 고정합니다. 설치된 TypeScript 선언의 `HookPermissionDecision`에는 `defer`, 성공 결과에는 `{ id, name, input }` 구조의 `deferred_tool_use`가 포함됩니다.

Massion의 `review` 왕복은 다음 순서입니다.

1. `PreToolUse`가 Governance 결정을 요청합니다. 자동 허용은 같은 도구 호출에만 provider 권한을 열고, 거부는 hook에서 즉시 차단합니다.
2. 검토가 필요하면 hook은 `defer`만 반환합니다. SDK가 종료된 뒤 terminal result의 session, 도구 호출 ID, 도구 이름, canonical 입력 SHA-256 digest가 hook 원본과 모두 일치할 때만 승인 대기를 공개합니다.
3. 승인되면 빈 입력 stream과 원 session ID로 `--resume`하여 새 사용자 turn을 만들지 않습니다. 다시 호출된 `PreToolUse`가 승인 ID에 결속된 같은 원 요청인지 확인한 뒤 한 번만 허용합니다.
4. 거부·취소는 session을 재개하지 않습니다. process 재시작으로 in-memory 결속을 잃었거나, 다중 병렬 도구가 defer를 요청하거나, `deferred_tool_use`가 달라지거나, resume에서 hook이 재평가되지 않으면 실패 폐쇄하고 자동 재시도하지 않습니다.
5. SDK 자체 provider permission callback은 hook에서 정확히 허용한 도구 호출만 통과시키는 2차 gate로 유지하고, 같은 authorization은 한 번만 소비합니다. 같은 `PreToolUse` 또는 provider 권한 요청의 재전달은 새 승인으로 처리하지 않고 실패 폐쇄합니다.

### 2.6 OpenAI Codex app-server

- OpenAI의 [app-server 개요](https://learn.chatgpt.com/docs/app-server)는 app-server를 Codex와의 양방향 JSON-RPC 통합 표면으로 설명하고 thread 시작·재개, turn 시작·중단, 알림과 서버 요청을 명시합니다.
- 같은 문서의 [승인 계약](https://learn.chatgpt.com/docs/app-server#approvals)은 명령 실행 승인(`item/commandExecution/requestApproval`)과 파일 변경 승인(`item/fileChange/requestApproval`)을 서버 요청으로 보내고 client 응답을 기다리는 구조를 명시합니다.
- Massion은 설치된 `@openai/codex` 0.144.1에서 생성한 TypeScript 계약으로 `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`와 두 승인 요청의 request·response 형태를 고정했습니다.
- `automatic`은 최종 결과만 필요한 공식 SDK 경로를 유지합니다. `review`는 app-server transport를 실행 수명 동안 열어 두고 명령·파일 승인 요청을 Governance에 전달합니다. 승인·거부는 prompt를 재실행하지 않고 보류 중인 같은 JSON-RPC 요청 ID에 `accept`·`decline`으로 답합니다.
- 취소는 아직 보류 중인 승인 요청에 `cancel`을 응답하고 같은 thread와 turn에 `turn/interrupt`를 보냅니다. 이전 session은 `thread/resume`으로 이어가며 process 종료나 요청 계보 불일치는 실패 폐쇄합니다.
- 이 승인 재개 계약은 서버 runtime에만 있습니다. Edge Codex는 `automatic`, `deny`만 지원하고 `review` 정책에서 모델 라우터가 선택 전에 제외합니다.

## 3. Massion 실행 경계

범용 외부 ACP CLI를 서버에서 바로 실행하지 않습니다. 서버 ACP process에는 검증된 OS sandbox가 아직 없으므로 resolver가 차단하고, Gemini·Copilot·Grok Build는 사용자 기기 연결기(edge connector)에서만 실행합니다. Codex와 Claude는 각각 검증한 공식 app-server·Agent SDK 전용 서버 adapter를 사용합니다.

연결 시 다음 조건을 모두 검증합니다.

1. 사용자가 실행 파일의 절대 경로를 명시합니다.
2. 실행 파일이 symlink가 아닌 일반 파일이고 현재 사용자에게 실행 가능하며 크기 상한 안에 있어야 합니다.
3. shell 없이 공급자별 공식 version 명령을 실행합니다.
4. SHA-256 digest와 version을 신원 문서(identity document)의 서명된 능력 목록에 넣습니다.
5. 신원 로드, heartbeat, 요청 실행 직전에 파일을 다시 측정하고 digest나 version이 바뀌면 차단합니다.
6. API key나 로그인 token 환경 변수는 자식 process에 전달하지 않습니다.
7. ACP 표준 파일 시스템 proxy를 제공해 읽기·쓰기를 서명된 workspace root로 제한하고, symlink 탈출·대용량 파일·읽기 전용 쓰기를 차단합니다.
8. Gemini는 공식 `--sandbox`, Grok Build는 공식 `--sandbox strict`를 Edge 실행에 추가합니다. Copilot은 기본 경로 검증을 끄는 `--allow-all-paths`를 전달하지 않습니다.

사용자는 `massion-connector enroll`에서 절대 실행 파일 경로(`--runtime-executable`)와 실험 기능 동의(`--accept-experimental true`)를 명시해야 합니다. 공급자 profile은 먼저 공식 CLI에서 로그인하고 Massion의 `secure-profile` 명령으로 owner-only 권한을 확인해야 합니다.

## 4. 권한과 부작용

Edge ACP의 `automatic` 정책은 무조건 허용이 아닙니다.

- 읽기·검색은 공급자가 경로를 명시하고 모든 실제 경로가 서명된 workspace root 안에 있을 때만 한 번 허용합니다.
- 편집·삭제·이동은 같은 경로 조건과 함께 작업공간 쓰기 정책(`workspace-write`)일 때만 허용하며, 읽기 전용 정책(`read-only`)에서는 거부합니다.
- 새 파일은 실제 상위 디렉터리를 확인해 symlink 탈출을 막습니다.
- shell 명령 실행은 검증된 process sandbox가 없으므로 항상 거부합니다.
- URL 접근은 조직 정책에서 network access가 켜진 경우에만 허용합니다.
- 판단·모드 전환처럼 외부 부작용이 없는 요청만 허용합니다.
- 알려지지 않은 도구 종류와 경로 없는 파일 작업은 거부합니다.

Edge ACP의 `deny`는 실행 전에 차단합니다. `review`는 현재 승인 재개 transport가 없으므로 지원한다고 표시하지 않고 실행 전에 차단합니다.

Codex 서버의 `review`는 명령·파일 요청을 동일 JSON-RPC request에 응답하는 동안만 유지합니다. Edge Codex는 Edge ACP와 마찬가지로 `review`를 제공하지 않습니다. 조직 정책이 `review`인 경우 라우터가 Edge credential을 제외하므로 실행 resolver에서 뒤늦게 실패하거나 자동 정책으로 낮아지지 않습니다.

## 5. 구현 근거와 검증 결과

주요 구현 파일은 다음과 같습니다.

- 공급자 공개 상태: `packages/subscriptions/src/provider-catalog.ts`
- Codex app-server JSON-RPC와 승인 adapter: `apps/server/src/codex-app-server.ts`, `apps/server/src/codex-app-server-agent.ts`
- Codex 표면별 후보 제외: `packages/router/src/model-router.ts`
- Claude 공식 defer·resume: `packages/runtime/src/subscriptions/claude-connector.ts`
- ACP process와 모델·취소·권한 protocol: `packages/runtime/src/subscriptions/acp-connector.ts`
- 실행 파일 측정과 재검증: `apps/connector/src/runtime-artifact.ts`
- 계정 신원·서명된 실행 파일 계보: `apps/connector/src/identity-store.ts`
- profile 인증 확인: `apps/connector/src/profile-health.ts`
- enrollment·실행·heartbeat: `apps/connector/src/enrollment.ts`, `apps/connector/src/executor.ts`, `apps/connector/src/client.ts`
- 공개 조회와 명령 검증: `packages/application/src/query-registry.ts`, `packages/application/src/adapters/domain.ts`
- 정책 저장소의 공급자별 승인 범위 검증: `packages/subscriptions/src/policy-store.ts`
- 공개 CLI·Web·TUI 상태와 선택 제한: `apps/cli/src/commands.ts`, `apps/web/src/pages/SubscriptionsPage.tsx`, `apps/tui/src/open-tui.ts`, `apps/tui/src/presentation.ts`

Edge 표면은 2026-07-12, Claude 승인 재개는 2026-07-13에 실행한 담당 범위 검증 결과입니다.

| 검증 | 결과 |
|---|---:|
| 공급자 catalog 테스트 | 23 passed |
| Claude Agent SDK runtime 테스트 | 17 passed |
| ACP runtime 테스트 | 13 passed |
| Edge connector 테스트 | 72 passed |
| Application 공개 조회·명령 검증 테스트 | 16 passed |
| 공급자 catalog·정책 저장소 테스트 | 29 passed |
| Codex app-server transport·agent adapter 테스트 | 6 passed |
| 구독 runtime resolver 테스트 | 20 passed |
| 모델 라우터 계약 테스트 | 40 passed |
| CLI 구독 명령 테스트 | 15 passed |
| Web 구독 화면 테스트 | 9 passed |
| TUI 표시 테스트 | 7 passed |
| TUI 실제 renderer 테스트 | 12 passed |
| 담당 7개 package TypeScript typecheck | passed |
| 담당 파일 ESLint | passed |

이 검증은 가짜 ACP fixture와 로컬 보안 fixture를 사용한 결정론적 검증입니다. 실제 Gemini Enterprise, Copilot, Grok 구독 계정으로 release artifact를 실행한 결과는 아닙니다. 실제 계정 UAT 영수증이 생기기 전에는 `supported`로 승격하지 않습니다.

## 6. 후속 승격 조건

- 실제 release 설치 환경에서 공급자별 로그인·모델 실행·취소·재인증을 성공시킵니다.
- 계정 전환, quota 소진, 429, offline, fallback 시나리오를 비밀 제거 영수증으로 남깁니다.
- Edge `review` 승인 요청을 영속화하고 원 실행을 안전하게 재개하는 transport를 구현합니다.
- ACP 공급자별 CLI version 호환성 범위와 protocol 회귀 fixture를 release gate로 고정합니다.
- Antigravity는 요청별 permission callback 또는 공식 SDK의 동등 계약, 인증 상태 probe, 계정 격리 계약을 모두 확인한 뒤에만 공개 enrollment를 추가합니다.
