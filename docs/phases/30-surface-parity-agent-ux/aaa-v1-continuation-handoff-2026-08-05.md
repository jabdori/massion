# Massion AgentOS AAA v1 작업 인계서

> 기준 시각: 2026-08-05 (Asia/Seoul)  
> 저장소: `/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-reconciled`  
> 브랜치: `feat/phase-30-reconciled`  
> 기준 커밋: `f8ce0368da6a391c2e246fad6b0729482650554a`  
> 제품 상태: **완료 아님 — 목표 일시 정지(paused), 아래 임계 경로부터 재개 필요**

이 문서는 다음 구현 에이전트가 이전 채팅 전체를 읽지 않고도 작업을 안전하게 이어가기 위한 실행 인계서입니다. 오래된 계획 문서나 fixture와 충돌할 때는 현재 소스 코드, Git 상태, 실제 데이터베이스와 런타임 증거를 우선합니다.

## 1. 한눈에 보는 현재 상황

Massion은 개인용 macOS 데스크톱 AgentOS를 만들고 있습니다. 사용자가 자연어로 실제 프로젝트 업무를 요청하면 운영체제 계층이 맥락을 읽고, 적절한 모델과 Agent를 배치하고, 협업방·인계·Task·Artifact·Assurance·Records를 연결해 업무를 끝까지 수행하는 제품입니다.

현재까지 저장소·보안·시작 복구·명령 응답 지연·i18n 기반·일부 UI 품질 결함은 수정됐습니다. 그러나 **새 빌드에서 실제 Work 한 건이 자연스럽게 완주했다는 출시 증거는 아직 없습니다.** 특히 Codex의 일시적 실패를 안전하게 분류해 다음 모델로 넘기는 경로, Runtime Agent 협업을 실제 방에 기록하는 배선, 실제 동적 배치 계보, 결과 파일 생성, 재시작 보존, 메모리·종료 수명주기 검증이 남았습니다.

다음 객관적 이정표는 코드 파일 수나 fixture 화면이 아니라 아래 한 문장입니다.

> 실제 데이터가 있는 환불 프로젝트에서 자연어 요청 하나로 모델 선택·협업·Task·Artifact·Assurance·Records가 완료되고 재시작 뒤에도 보존된다. 이어서 별도 capability-gap 프로젝트에서 명시적 배치 지시 없이 동적 Agent 제안·승인·참여가 완료된다.

## 2. 제품 의도와 품질 계약

### 2.1 사용자가 기대하는 경험

- 사용자는 내부 실행 절차를 프롬프트에 지시하지 않습니다. AgentOS가 업무 성격에 따라 계획·모델 선택·Agent 배치·검증·기록을 자연스럽게 수행해야 합니다.
- 협업방에는 실제 대화, 사람이 읽을 수 있는 Agent 이름, 사용 모델, `Atlas → Lyra` 같은 인계 흐름이 보여야 합니다.
- Task, 동적 Agent, 모델 계보, ArtifactVersion, Assurance, Records, 지식 그래프는 서로 연결되어야 합니다.
- fixture의 풍부함은 제품이 도달해야 할 기대 기능과 시각 품질입니다. 다만 fixture 데이터 자체는 실제 제품 동작의 증거가 아닙니다.
- 화면은 아름답기만 한 것이 아니라 일관되어야 합니다. 채팅 스크롤, Markdown, 정보 밀도, 구분선, 이름·시간 표현과 접근성 기본선이 실제 사용 흐름을 방해하면 안 됩니다.
- 내부용 다음 단계나 검증 지시를 사용자에게 그대로 노출하지 않습니다.

### 2.2 출시 범위

포함:

- Tauri 기반 macOS 데스크톱 앱
- 실제 Codex 인증을 사용하는 Work 실행
- Provider와 안전한 모델 fallback
- 동적 Agent·모델 할당과 승인·조직 반영
- 협업방·인계·Task·Artifact·Assurance·Records 완주
- 시스템 언어 기본값과 설정에서 전환 가능한 영어(en)·한국어(ko)
- 재시작 보존, 데이터 손실 방지, 보안 경계, 접근성 기본선
- 실제 프로세스 메모리와 종료 소유권 검증

현재 임계 경로에서 제외:

- TUI와 레거시 Web(`apps/studio` 포함)
- 비차단 문서 정리와 광범위한 미관 보정
- 모든 변경마다 전체 빌드
- 개인용 v1 단계에서의 과도한 서명·공증 작업
- 근거 없는 가상 업무나 프롬프트에 `UAT`, 내부 단계, Agent·모델을 직접 지시하는 시험

### 2.3 운영 방식

한 묶음은 다음 순서로 닫습니다.

1. 실패 테스트(RED)로 전체 실패 계열과 truth table을 먼저 고정합니다.
2. 공통 원인에 최소 구현을 적용합니다.
3. 표적 테스트와 Prettier·diff check를 실행합니다.
4. 구현자 1명과 독립 검수자 1명으로 통합 검수 1회를 수행합니다.
5. 같은 계열 지적을 일괄 수정하고 최종 재검수합니다.
6. 검증된 원자 변경을 즉시 커밋·푸시합니다.

추가 규칙:

- 하위 에이전트의 재귀 확장을 금지합니다. 독립 축마다 구현자 1명·검수자 1명만 둡니다.
- 소스 수정과 표적 테스트만 병렬화합니다. 공유 `dist`를 건드리는 build/typecheck는 루트의 단일 직렬 큐에서만 실행합니다.
- 이미 승인된 영역을 다음 검수에서 전면 재조사하지 않습니다. 수정된 경계와 인접 회귀만 봅니다.
- 새 공개 커밋 메시지는 **영어 Conventional Commits**로 작성하고 상세 본문을 포함합니다.
- 검증된 원자 변경마다 커밋하고 원격에 푸시합니다.
- 현시점에는 release tag가 존재하면 안 됩니다.

## 3. Git과 작업 트리 상태

2026-08-05 이 문서를 추가하기 직전 재확인 결과:

```text
branch: feat/phase-30-reconciled
HEAD:   f8ce0368da6a391c2e246fad6b0729482650554a
origin: f8ce0368da6a391c2e246fad6b0729482650554a
status: clean (이후 이 인계서 1개만 추가)
tags:   none
```

다음 에이전트는 시작 즉시 다시 확인해야 합니다.

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse '@{u}'
git tag --list
```

사용자 데이터나 현재 DB를 임의로 삭제하거나 `git reset --hard`, `git checkout --` 같은 파괴적 명령을 사용하지 마세요.

## 4. 지금까지 완료한 주요 변경

아래 항목은 커밋·푸시됐습니다. “완료”는 각 원자 변경에 대한 의미이며 전체 v1 완료를 뜻하지 않습니다.

| 커밋 | 변경 | 검증 근거 |
|---|---|---|
| `b2ac33644` | `feat(i18n): add English and Korean locale foundations` | 영어·한국어 locale 기반 추가 |
| `2b45860e5` | `fix(i18n): localize dynamic desktop content` | 동적 데스크톱 콘텐츠 현지화; 당시 desktop 273/273, ESLint 통과 |
| `d3e38c4c7` | `fix(runtime): bound local SurrealDB memory` | 로컬 SurrealDB 메모리 상한 조정 |
| `be31ca517` | `fix(quality): clear release lint blockers` | 출시 lint 차단 제거 |
| `1c0cebff0` | `test(desktop): align graph accessibility assertions` | 그래프 접근성 assertion 정렬, 독립 검수 통과 |
| `5996ac182` | `fix(security): patch vulnerable transitive dependencies` | 취약한 전이 의존성 보정 |
| `ed63a141a` | `fix(server): decouple startup from quota polling` | quota polling이 서버 시작을 막지 않도록 분리 |
| `11ec0954a` | `fix(server): keep startup available during work recovery` | 외부 모델 복구를 readiness 전경에서 분리; server 43 files 통과/2 skipped, 359 tests 통과/2 skipped |
| `bde95f8b1` | `fix(storage): avoid transaction session teardown stalls` | transaction별 session attach/detach 제거, rollback 오류 보존, storage 21 통과/1 skipped, 검수 PASS |
| `f8ce0368d` | `fix(application): return commands before event projection` | command 응답을 역사적 projection backlog에서 분리, 조직별 coalescing; application 52 files 통과/1 skipped, 533 통과/1 skipped, 검수 PASS |

### 4.1 시작 복구(startup recovery) 결함

기존에는 `ApplicationRunStartupRecoveryService.start()`가 외부 모델 복구를 기다린 뒤 HTTP listen으로 넘어가 readiness가 30초 안에 열리지 않았습니다. 복구를 background로 옮기고 close 동작과 readiness 계약을 고정했습니다.

이 변경은 테스트로 통과했지만, 최신 데스크톱 번들에서 전체 사용자 흐름으로 다시 확인해야 합니다.

### 4.2 명령 응답 지연 결함

실제 시험에서 workspace 등록·신뢰·run 시작·재개 명령은 DB에 저장됐지만 UI promise가 돌아오지 않았습니다. 직접 HTTP 요청도 12초 동안 응답 바이트가 없었고, DB 행은 약 119ms에 성공했습니다.

원인은 두 개였습니다.

1. 모든 transaction마다 `forkSession()`을 만들고 commit 뒤 `closeSession()`/detach를 기다렸습니다.
2. Application product가 command와 metric을 commit한 뒤 6천 건 이상의 과거 outbox projection까지 기다린 다음 응답했습니다.

`bde95f8b1`과 `f8ce0368d`에서 각각 공통 원인을 수정했습니다. 하지만 **수정된 새 번들을 실제로 실행해 HTTP와 UI 응답을 재검증하기 전에 이전 작업이 중단됐습니다.** 이것이 재개 후 첫 검증입니다.

## 5. 빌드와 런타임의 정확한 현재 상태

### 5.1 Tauri 번들

다음 명령을 루트 단일 직렬 큐에서 실행했습니다.

```bash
pnpm --filter @massion/desktop tauri:build
```

도중에 작업 턴이 끊겨 shell exit code를 보존하지 못했습니다. 다만 아래 번들은 2026-08-04 12:24:23 +0900 시각으로 생성됐습니다.

```text
apps/desktop/src-tauri/target/release/bundle/macos/Massion.app
```

따라서 상태는 **artifact emitted / build exit 미확인**입니다. 완전한 build PASS로 기록하면 안 됩니다. 최신 명령 응답 수정이 포함된 이 번들을 아직 실행·검증하지 않았습니다.

### 5.2 현재 프로세스

마지막 확인 당시 Massion 앱·server·bridge는 종료된 상태였습니다. SurrealDB만 부모 프로세스가 1인 orphan으로 남아 있었습니다.

```text
PID 68252
PPID 1
RSS 123,456 KiB (약 120.6 MiB)
elapsed 1일 3시간 35분 이상
command ~/.local/share/massion-v1/runtime/surrealdb/3.2.1/darwin-arm64/surreal start ... --bind 127.0.0.1:7330
```

이 프로세스는 앱이 종료된 뒤에도 장시간 남는 daemon이라는 관측 증거입니다. 다만 `packages/local-control/src/local-surreal-runtime.ts`는 state·PID·실행 파일을 검증한 기존 프로세스를 `already-running`으로 재사용하도록 구현돼 있습니다. 따라서 이것만으로 shutdown 결함이라고 단정할 수 없습니다. Cmd-Q 시 종료가 계약인지 장수 daemon 재사용이 계약인지 정본화하고, 재실행의 attestation·attach/reuse·포트 동작을 검증한 뒤 판정하세요. 영속 DB를 맹목적으로 kill하거나 삭제하지 마세요.

## 6. 실제 사용 시나리오와 남은 Work

### 6.1 근거 데이터 프로젝트

실제와 같은 시험용 프로젝트가 다음 경로에 있습니다.

```text
/tmp/massion-refund-project-20260804
```

파일:

- `README.md`
- `batch-policy.md`
- `data-dictionary.md`
- `refunds.csv` — header 포함 25줄, 24개 record

아직 생성되지 않은 기대 산출물:

```text
refund-delay-report.md
```

데이터는 익명 synthetic record이지만 내부적으로 완결되어 있고 production/customer data는 없습니다. 정책은 검토된 환불을 다음 09:00 KST daily batch에 넣습니다. 이전 복구 가능 설정은 09:00·17:00이며, 현재 once-daily 설정은 migration 없이 되돌릴 수 있습니다. rollback은 `batch_schedule=09:00` 복원과 restart 전 active queue drain을 요구합니다.

독립 계산 기대값:

| 구간 | 평균 |
|---|---:|
| 요청 → 검토 | 2.7917시간 |
| 검토 → batch | 20.5417시간 |
| batch → 지급 | 2.0000시간 |

사용할 자연어 요청은 다음과 같습니다.

```text
이 폴더의 환불 처리 기록을 분석해 가장 큰 지연 구간과 개선안을 찾고, 근거가 되는 수치와 되돌리기 조건을 refund-delay-report.md에 정리해 주세요.
```

이 문구에 `UAT`, 내부 계획·실행·검증·기록 단계, 사용할 Agent나 모델, “사실을 만들지 말라” 같은 메타 지시를 추가하지 마세요. 제품이 프로젝트 데이터와 업무 의도를 바탕으로 스스로 동작하는지 검증해야 합니다.

### 6.2 저장된 Work와 run

마지막 DB 확인 값:

```text
Work
  id:     88aab4fe-f02b-42e4-b2d6-2327e5d43cf7
  status: draft
  title:  null

ApplicationRun
  id:               f904035a-8764-41d6-b7be-198f087fcf1a
  work_id:          88aab4fe-f02b-42e4-b2d6-2327e5d43cf7
  status:           blocked
  stage:            context-strategy
  retry_attempt_id: 7ebb440a-a4bc-41d8-8dde-f7f9ef77d17b
```

마지막 확인 당시 pending outbox는 6,076건이었습니다. Surreal의 `transaction not found` warning 누적은 1,462건이고 새 번들 검증 직전 기준값을 다시 기록해야 합니다.

### 6.3 실제 UI에서 확인된 것

환불 Work의 실제 협업방에는 사용자 질문, `Atlas → Lyra` 인계, `glm-5.2` 모델 표시, Core Office 참가자 9명이 나타났습니다. 그러나 context-strategy 단계에서 멈췄고 Task는 0/0이었습니다.

이전에 복구된 다른 Work에서는 사람 이름과 모델명, `Atlas → Lyra` 인계, 동적 Agent `Umbra`·`Brook`, Task 2/2, Artifact, 진행 중 Assurance가 실제 데이터로 보였습니다. 이는 일부 풍부한 배선이 존재한다는 근거이지, 환불 시나리오 완주나 전체 v1의 증거는 아닙니다.

## 7. 현재 최우선 코드 결함: Codex fallback과 모델 계보

별도 디버거가 읽기 전용으로 원인을 추적했으며 아직 수정 커밋은 없습니다.

### 7.1 현재 후보

실제 planning route 설정에는 다음 세 후보가 있습니다.

1. Z.AI GLM-5.2 — priority 1
2. Codex `gpt-5.6-sol` — priority 1
3. Hugging Face `deepseek-ai/DeepSeek-V4-Flash-0731` — priority 100

Hugging Face 연동과 model ID는 이미 `apps/server/src/deepseek-community-provider.ts`에 있습니다. 그러나 2026-08-05에 등록된 endpoint의 `/v1/models`를 비밀 없이 직접 조회한 결과 HTTP 404와 `free public endpoint ... has been retired` 응답을 확인했습니다. Space 문서가 남아 있어도 이 무료 endpoint는 현재 사용 불가능합니다. 따라서 이를 성공 가능한 fallback으로 계산하거나 다른 실제 endpoint가 승인되기 전에 대체 Provider를 임의로 추가하면 안 됩니다. 현재 route에서는 unavailable 후보로 안전하게 제외·정산해야 합니다.

### 7.2 관측된 실패

- representative 단계는 Z.AI GLM-5.2로 성공했습니다.
- 실패한 context-strategy는 실제로 Codex `gpt-5.6-sol`을 선택했습니다.
- UI에는 representative 모델인 GLM만 보여 실제 모델 계보를 오인하게 했습니다.
- 실패 attempt는 `emitted_tokens=0`, `failure_class=unknown`, `side_effects_started=true`, `status=interrupted`, `fallback_allowed=false`였습니다.
- 따라서 다음 GLM/Hugging Face 후보로 넘어가지 않았습니다.
- 수동 retry는 queued execution을 만들었지만 running event나 route attempt가 없어 orphan queue가 남았습니다.

### 7.3 근본 원인 위치

- `apps/server/src/codex-app-server-agent.ts` 약 120–137, 501–516줄
  - 현재 401/auth 실패만 안전하게 분류합니다.
  - 공식 Codex app-server의 usage limit, HTTP 429/5xx, stream/network 실패가 `unknown + sideEffectsStarted=true`로 뭉개집니다.
- `packages/runtime/src/voltagent-runner.ts`
  - `failureSignal()`은 marker가 있는 structured JSON parse 오류를 이미 `output`으로 분류합니다.
  - schema validate 실패는 adapter가 `validation.error` 원문을 reject하므로 marker가 없으면 `unknown`이 됩니다. typed/normalized output failure가 필요합니다.
  - catch에서 agent-runtime lease의 모든 오류를 `sideEffectsStarted=true`로 넘겨, 실제 외부 효과가 없던 output failure도 fallback을 막습니다.
  - `createExecution` 뒤 running 전환 예외가 나면 queued 상태가 terminalize되지 않습니다.
- `packages/runtime/src/execution-store.ts` 약 322–369줄
  - queued execution을 먼저 commit한 뒤 configuration resolve·attach를 수행합니다.
  - configuration resolve가 reject하면 runner는 execution ID를 받지 못하므로 runner만으로 보상할 수 없습니다. 이 경계까지 truth table에 포함하려면 store의 보상·원자성 또는 execution ID를 보존하는 typed error 계약이 필요합니다.
- `packages/router/src/model-router.ts`
  - `retryable failure + emitted=0 + sideEffects=false`일 때만 fallback을 허용하는 보안 경계는 옳습니다.
  - **router 보안 조건을 완화하지 마세요.** adapter와 runner가 정확한 실패 정보를 넘기도록 고쳐야 합니다.
- `apps/desktop/src/desktop-service.ts` 약 5790줄 이후, `apps/desktop/src/app.tsx` 약 6255줄 이후
  - 모든 전략 실패를 “구조화 응답 실패”라고 고정 표시합니다. 최소한 `전략 계획 생성을 완료하지 못했습니다.`처럼 사실에 맞는 표현이 필요하며, 최종적으로 실제 route attempt 모델 계보를 투영해야 합니다.

### 7.4 반드시 테스트로 고정할 truth table

| 상황 | 기대 결과 |
|---|---|
| Codex 429/5xx/stream/network, 출력 0, command/file/tool 없음 | failed, fallback 허용, 다음 후보 attempt 연결 |
| structured JSON parse invalid, buffered only, 외부 효과 없음 | 기존 output failure 분류를 보존하고 실제 부작용 false로 정산, fallback 허용 |
| schema validate 실패, buffered only, 외부 효과 없음 | typed/normalized output failure, 실제 부작용 false, fallback 허용 |
| commandExecution/fileChange/MCP/approval request/알 수 없는 item 관측 | interrupted, fallback 금지 |
| 402/403/BadRequest/policy/input/cancel | fallback 금지 |
| 사용 가능한 후보 없음 | secret-free `blocked_model_unavailable`, terminal; queued/running orphan 0 |
| configuration resolve/attach 또는 running 전환 실패 | store/runner 경계에서 생성한 queued execution을 terminalize하고 execution ID·원인 category 보존 |
| 후보 전환 | route attempt chain 단조 증가, UI가 대표 모델 하나가 아닌 실제 계보 표시 |

필수 표적 테스트:

- `apps/server/src/codex-app-server-agent.test.ts`
  - 기존 “non-401 429 fallback forbidden” 기대를 안전한 429/503/stream truth table로 교체
  - tool/item 관측 variant는 fallback 금지 유지
  - schema invalid의 no-tool/after-tool 분리
- `packages/runtime/src/voltagent-runner.test.ts`
  - no-side-effect structured failure가 두 번째 모델로 이동하고 attempt/lease lineage 보존
  - sideEffects=true는 첫 attempt만 terminalize
  - pre-running transition reject가 queued orphan을 남기지 않음
- `packages/runtime/src/execution-store.test.ts`
  - configuration resolve/attach reject가 queued orphan을 남기지 않거나, 보상 가능한 execution ID를 typed error로 보존
- product integration
  - Codex transient → GLM 성공
  - Codex → GLM output failure → retired Hugging Face 후보 unavailable 정산, secret-free terminal, orphan 0
  - 실제 UI·DB에 모델 attempt chain 표시

이 묶음을 닫기 전 예산·새 UI·TUI·Web·다른 기능 축을 열지 마세요.

## 7.5 출시 차단 GAP: Runtime Agent 협업방 배선

정본 아키텍처는 `REQ-AGENT-HARNESS-001`을 `in-progress`로 명시합니다. 현재 협업방 도메인과 VoltAgent 위임은 각각 존재하지만 연결되어 있지 않습니다.

확인된 생산 경로:

- `packages/application/src/core-pipeline.ts`가 사용자 요청과 Representative handoff 두 건만 기록합니다.
- `packages/runtime/src`에는 `postMessage` 호출이 0건입니다.
- 따라서 Agent 간 `delegate_task` 위임·질문·답변은 VoltAgent 메모리에서 끝나고 실제 협업방·재시작 계보에 남지 않습니다.
- 상세 계약과 기존 seam은 `docs/phases/30-surface-parity-agent-ux/agent-collaboration-runtime-handoff.md`에 정리돼 있습니다.

fallback 묶음이 끝난 뒤, 실제 Work 검증 전에 이 GAP을 별도의 출시 차단 원자 묶음으로 닫아야 합니다. 권장 최소 경로는 기존 `ExecutionDeltaObserver` seam과 이미 있는 Work command·execution delta·idempotent command ID 계약을 재사용하는 것입니다. 다만 fire-and-forget in-memory queue만으로는 delta 직후 crash에서 메시지가 영구 유실됩니다. 실행을 기록 실패로 죽이지 않는 원칙을 유지하면서 durable outbox/event enqueue, terminal 전 drain/ack, 또는 명시적 degraded 상태와 recovery source 가운데 저장소의 기존 패턴에 맞는 최소 durability 경계를 사용해야 합니다.

최소 truth table:

| Runtime 사건 | 영속 결과 |
|---|---|
| supervisor `delegate_task` tool-call | `handoff` 또는 `question`, supervisor handle, execution ID |
| subAgent tool-result | `answer`, subAgent handle, 원 메시지의 reply/caused-by |
| retry/recovery replay | 중복 메시지 0, 같은 idempotent command 결과 |
| room token/cost/round 한계 | 정의된 차단 상태, Runtime process crash 없음 |
| 메시지 기록 실패 | 실행을 죽이지 않지만 로그·event로 관측 가능 |
| delta 영속 전 process crash | durable source에서 replay하거나 terminal을 degraded로 막아 조용한 유실 0 |
| terminal 전 미확정 메시지 존재 | drain/ack 완료 또는 복구 가능한 pending 상태 보존 |
| restart | 협업 메시지·인과·execution lineage 보존 |

합격 근거는 실제 Provider Work에서 방 메시지가 사용자 요청·대표 인계 두 건을 넘어 Agent 위임과 답변까지 실제 데이터로 남는 것입니다. fixture activity를 복사하면 실패입니다.

환불 분석 Work와 동적 Agent 배치 Work는 구분합니다. 환불 업무에 현재 조직 밖의 capability가 필요하다는 근거가 없다면 동적 배치가 발생하지 않는 것이 정상일 수 있습니다. 동적 배치 검증은 실제 파일이 있는 별도 프로젝트를 만든 뒤, 현재 조직 capability snapshot에 없는 역량이 업무상 필요하다는 precondition을 코드·DB에서 먼저 증명하고 자연어 업무 요청으로 실행하세요. 프롬프트에 동적 Agent·모델·승인 절차를 직접 지시해서는 안 됩니다.

## 8. 메모리와 프로세스 수명주기

사용자가 Activity Monitor에서 살아 있는 Massion 프로세스가 40.99GB를 소비하는 화면을 제공했습니다. 이는 앱 종료 후 잔여 프로세스가 아니라 실행 중 앱의 메모리 문제 제보입니다.

`d3e38c4c7` 이후 fresh run 15분 sampling 메모에는 전체 Massion app/node/server/Surreal 합계가 약 2.17GB에서 1.6–2.1GB 사이로 변동했고 마지막은 약 1.72GB였다고 남아 있습니다. 당시 대부분은 active Surreal 약 1.45GB였습니다. 그러나 저장소나 `/tmp`에서 원시 sample artifact를 찾지 못했으므로 이 수치는 참고 관측이며 출시 증거로 사용하면 안 됩니다.

따라서 정확한 상태는 다음과 같습니다.

- 40GB 증상: 사용자가 실제 관측함
- 메모리 상한 수정: 커밋됨
- fresh 15분에서 40GB 재현: 실패
- 장시간 active Work 및 idle에서 완전 해결 증거: 없음
- 정상 Cmd-Q 뒤 app/bridge/server와 재사용 가능한 SurrealDB의 수명주기 계약: 미확정

Work 완주 뒤 새 번들에서 먼저 15분 idle+active 표적 회귀를 수행해 구성 요소별 PID/RSS를 나눠 기록하세요. 최종 DoD에는 이보다 긴 bounded soak가 필요합니다. idle·active 구간, 반복 Work 전후, component별 RSS·slope·peak와 DB 크기/heap 지표를 원시 timestamp sample artifact로 저장하세요. 정상 Cmd-Q 뒤 앱과 bridge·server가 종료되는지, SurrealDB는 정본 수명주기 계약에 따라 종료되거나 attested daemon으로 안전하게 재사용되는지 확인해야 합니다. 단순 aggregate나 같은 15분 재실행만으로 40GB 문제가 해결됐다고 결론 내리지 마세요.

## 9. i18n 상태

사용자 계약은 시스템 설정 언어를 기본값으로 따르고 설정에서 사용자가 변경할 수 있으며 초기 언어는 영어(en)와 한국어(ko)입니다.

두 i18n 커밋으로 기반과 동적 콘텐츠 일부를 구현했습니다. 그러나 전체 제품 완료로 간주하지 않습니다. 최종 실제 UAT에서 다음을 확인해야 합니다.

- 최초 실행 시 시스템 locale 선택
- 설정에서 en/ko 변경
- 선택값 재시작 보존
- 정적·동적 UI, 날짜·숫자, 검색, 오류 메시지의 locale 일관성
- Agent 출력 언어 계약
- 한 화면에서 raw 한국어·영어가 의도 없이 섞이지 않음

현재 fallback·실제 Work 완주 임계 경로를 먼저 닫고 i18n 잔여 배선을 여세요.

## 10. 재개 후 정확한 실행 순서

### 단계 0 — 기준선 보존

1. 이 문서를 읽습니다.
2. Git clean·upstream 동일·tag 없음 상태를 확인합니다.
3. 현재 DB와 `/tmp/massion-refund-project-20260804`를 보존합니다.
4. 새로운 조사 축을 열지 않습니다.

### 단계 1 — 생성된 최신 번들 실행과 command 응답 검증

```bash
open -n '/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-reconciled/apps/desktop/src-tauri/target/release/bundle/macos/Massion.app'
```

`/health/ready`가 열린 뒤 다음을 확인합니다.

- 실행 전 `transaction not found` warning 기준값 기록
- workspace register 명령을 3초 이내에 응답하는지 직접 HTTP로 확인
- operation/outcome/data가 올바른지 확인
- DB command가 final인지 확인
- warning 증가량 0 확인
- UI의 register/trust/run/resume에 무한 spinner가 없는지 확인

이전 idempotent replay 식별자:

```text
command_id:     0c04deb0-3014-4dea-a4c5-9aba6459592c
correlation_id: cdc7bdf4-b0f0-4d8b-9e90-50999679a763
workspace path: /private/tmp/massion-refund-project-20260804
access token:   ~/.config/massion-v1/access.token
```

token 값은 terminal이나 채팅에 출력하지 마세요. 정확한 기존 HTTP envelope는 관련 integration test와 server route에서 확인해 재사용하세요. 추측으로 payload를 만들지 않습니다.

### 단계 2 — Codex fallback·queued orphan 묶음만 수정

1. 7.4의 truth table 전체를 RED로 만듭니다.
2. Codex adapter가 공식 error 종류와 실제 부작용 관측 여부를 정확히 반환하게 합니다.
3. runner가 기존 output failure 분류를 보존하면서 실제 부작용 여부로 정산하게 합니다.
4. execution store와 runner 경계에서 config/transition 전 실패의 queued execution을 terminalize하게 합니다.
5. router 보안 gate는 유지합니다.
6. 실제 route attempt 계보가 제품 데이터에 투영되게 합니다.
7. 표적 테스트·Prettier·diff check를 수행합니다.
8. 독립 검수자 1명이 첫 검수에서 동일 계열 전체를 조사합니다.
9. 지적을 일괄 수정하고 재검수합니다.
10. 영어 Conventional Commit으로 즉시 커밋·푸시합니다.

### 단계 3 — Runtime Agent 협업 기록 배선

1. `agent-collaboration-runtime-handoff.md`와 정본 아키텍처 7절을 읽습니다.
2. 실제 `delegate_task` 한 번을 RED로 재현해 방에 메시지가 두 건만 남는 현재 상태를 고정합니다.
3. 기존 execution delta observer와 Work message command를 연결합니다.
4. handoff·answer의 author, reply/caused-by, execution ID, token/cost, idempotency를 검증합니다.
5. 기록 실패·방 한계·retry·restart truth table을 검증합니다.
6. 표적 테스트·포맷·통합 독립 검수 후 별도 영어 Conventional Commit으로 커밋·푸시합니다.

### 단계 4 — 번들 1회 직렬 재빌드

```bash
pnpm --filter @massion/desktop tauri:build
```

이번에는 exit code, artifact path, timestamp를 기록합니다. 다른 에이전트가 동시에 build/typecheck를 실행하면 안 됩니다.

### 단계 5 — 자연스러운 환불 분석 Work 완주

새 번들에서 같은 환불 프로젝트와 6.1의 자연어 요청을 사용합니다. 기존 run을 안전하게 resume할 수 없으면 동일 프로젝트로 fresh Work를 시작해도 됩니다. 이 시나리오와 첫 임계 이정표의 증거는 fresh run 하나가 완주하는 것입니다. 전체 출시 증거는 단계 6–12까지 모두 필요합니다.

합격 기준:

- 실제 route attempt chain과 선택 모델이 DB·UI에서 일치
- OS가 실제 capability 필요성을 판단한 결과와 선택 이유가 계보에 남음
- 협업 메시지는 실제 pipeline event이며 fixture activity 복사가 아님
- 사람이 이해할 수 있는 이름과 모델명 표시
- `Atlas → Lyra` 형태의 인계와 답변 연결
- Task가 0개가 아니며 완료됨
- 프로젝트 폴더에 `refund-delay-report.md` 생성
- 산출물의 수치가 원본 CSV와 일치하고 rollback 조건 포함
- ArtifactVersion 저장·표시
- Assurance가 실제 파일과 데이터 근거로 통과
- Records 완료
- run이 terminal `completed`
- 사용자에게 내부 UAT·단계 지시·불필요한 운영 문구를 노출하지 않음

### 단계 6 — 자연스러운 동적 배치 Work 완주

환불 Work에 동적 배치를 억지로 요구하지 않습니다. 별도의 실제 파일 프로젝트에서 현재 조직에 없는 필수 capability를 먼저 증명한 뒤, 내부 절차를 언급하지 않는 자연어 업무 요청을 사용합니다.

합격 기준:

- capability gap이 업무 입력과 현재 organization snapshot에서 재현 가능
- OS가 명시적 배치 지시 없이 proposal을 생성
- 승인 정책에 따라 실제 승인 또는 허용된 자동 승격을 거침
- 새 Agent가 organization version에 원자적으로 반영
- 협업방에 참가하고 실제 handoff·answer를 기록
- 해당 Agent의 Task·RuntimeExecution·Artifact 기여가 같은 계보로 연결
- Work 종료·취소·재시작에서 scope와 membership이 계약대로 보존 또는 정리

### 단계 7 — 재시작 보존

정상 Cmd-Q 후 앱을 다시 실행합니다. Work, room messages, handoff, Tasks, ArtifactVersion, Assurance, Records, route attempt lineage가 유실 없이 같은 의미로 보이는지 확인합니다.

### 단계 8 — 메모리·종료 검증

- 빠른 gate로 idle과 active Work를 포함한 15분 sampling
- 최종 gate로 반복 Work를 포함한 더 긴 bounded soak; 시간은 사용자 관측을 재현할 수 있게 사전 고정
- app, bridge, server, SurrealDB별 PID·PPID·RSS·elapsed 분리
- timestamp별 원시 sample artifact, slope, peak, 반복 Work 전후 DB·heap 변화 기록
- 정상 Cmd-Q 후 앱 계층 종료와 Surreal attested reuse/termination 계약 확인
- Surreal이 계속 남으면 owner/attach/reuse/shutdown 중 어떤 동작이 정본인지 먼저 고정한 뒤 필요한 경우 최소 수정

### 단계 9 — 첫 실제 Work 이정표 뒤 v1 잔여 계약 폐쇄

단계 1–8은 범위가 동결된 **첫 실제 Work 임계 이정표**입니다. 통과했다고 전체 v1이 끝난 것이 아닙니다. 새 축을 동시에 열지 말고 아래 정본 인계서를 하나씩 같은 원자 흐름으로 닫습니다.

| 표면·축 | 현재 확인된 GAP | 정본 인계·근거 | 실제 완료 증거 |
|---|---|---|---|
| 지식 | K03·K04 화면 UAT, 관계 graph 계약 투영 미완료 | `v1-delivery/phase-03-knowledge-memory.md`, `knowledge-surface-handoff.md`, `knowledge-graph-handoff.md` | 실제 workspace 검색·1-hop 관계·Work citation·memory 적용/해제·재시작 보존 |
| 조직 | 계층·scope·work ID와 staffing proposal은 계약부터 Desktop까지 연결됨; fixture 없는 승인/거절·version·revert 실제 UAT가 미완료 | 현재 source contract/read-model/query/desktop projection, `agent-collaboration-runtime-handoff.md` | 실제 조직 snapshot·proposal·승인/거절·version/revert가 fixture 없이 일치 |
| 개선(Growth) | 근거·평가·신호·효과 조회와 typed 명령, review/auto 채택 미연결 | `growth-adoption-handoff.md` | 완료 Work → Reflection/Suggestion → 근거·반대 증거 → review 또는 auto 채택 → 후속 효과 → revert |
| 확장 | 설치 Capability 선언을 Application 계약과 Agent Runtime이 소비하지 않음 | `extension-capability-handoff.md` | 설치된 Skill/Tool Capability가 조직과 실제 Work에 기여하고 권한·제거가 보존 |
| Provider | 연결·계정·키는 동작하지만 모델 개별 on/off 계약 미완료; 등록된 무료 HF endpoint retired | 제품 헌법 §6·§9.1, server provider tests | 실제 연결·모델 공급 목록·enable/disable·unavailable·fallback이 secret 없이 일치 |
| 예산 | guard 명령과 route_attempt 조회가 없어 한도·알림·호출 기록이 제품 경로에 미연결 | `settings-contract-handoff.md`, 제품 헌법 §9.1 | route별 한도·임계값 저장/재시작, 호출·비용·fallback 계보 관측, 실제 hard limit 차단 |
| 설정 | 실행 권한과 Growth 채택 모드, locale의 저장·재시작 계약 전체 검증 필요 | `settings-contract-handoff.md`, `growth-adoption-handoff.md` | permission mode·review/auto·en/ko가 실제 행동을 바꾸고 재시작 보존 |
| 홈·업무·수신함 | 실제 상태가 단일 원천으로 같은 의미를 보여야 함 | 제품 헌법 §6, v1 delivery 기록 | 승인·차단·개선 대기가 배지·홈·수신함·소유 화면에서 동일하고 해결 후 제거 |

정본의 아홉 표면은 홈·업무·지식·조직·개선·확장·프로바이더·예산·설정입니다. 화면이 존재하거나 fixture가 풍부하다는 이유로 해당 축을 완료 처리하지 마세요. 실제 command/query/runtime wiring과 영속 증거가 필요합니다.

### 단계 10 — bounded negative scenario matrix

happy path 두 건만으로 AAA v1을 판정하지 않습니다. 다음 경계 시나리오는 실제 파일·실제 제품 경로로 범위를 고정해 검증하고 비밀 없는 evidence를 남깁니다.

| 시나리오 | 기대 결과 |
|---|---|
| 자료가 부족하거나 서로 모순됨 | 필요한 질문 또는 근거 있는 blocked 상태; 존재하지 않는 사실·산출물 생성 금지 |
| 동적 조직 proposal 승인 거절 | organization version·membership 불변, 실행은 정의된 대체/차단 상태 |
| 실행 중 사용자 취소 | 새 stage·side effect 차단, lease/task 정리, 재시작 후 cancelled 보존 |
| stage commit 직후 process crash | idempotent recovery, 중복 Task·message·Artifact 없음 |
| 신뢰되지 않은 workspace 또는 범위 밖 쓰기 | fail-closed, 외부 파일 변경 0, 사람이 이해할 수 있는 오류 |
| Provider auth/429/5xx/retired endpoint | 보안 truth table에 따른 fallback 또는 terminal, secret 미노출, orphan 0 |
| 예산 임계값·hard limit 도달 | 알림과 실제 route 차단이 같은 저장값을 사용하고 재시작 뒤 유지 |
| Growth 근거 충돌·stale source | auto mode도 채택 금지 또는 review 승격; 조직·prompt·memory 버전 불변 |
| en/ko 각각 실제 Work | UI·오류·날짜·숫자·Agent 출력 언어 계약 일치, 재시작 보존 |
| 반복 Work와 장시간 idle/active | 메모리 bounded, 이전 Work 데이터 혼입 없음, 정상 수명주기 |

### 단계 11 — Tauri 시각·접근성 검수

실제 Work가 완주한 뒤에만 수행합니다. fixture와 blind comparison하되 fixture는 증거가 아니라 기대 기준으로 씁니다.

확인 항목:

- 채팅 스크롤 가능
- Markdown 렌더링
- 과도한 divider가 흐름을 끊지 않음
- UUID와 raw timestamp 대신 의미 있는 이름과 locale 시간
- 실제 모델명·모델 계보 표시
- Task·동적 Agent·handoff·Artifact·Assurance·Records가 누락되지 않음
- 내부적인 “다음 단계” 지시를 사용자에게 불필요하게 노출하지 않음
- 키보드 접근성과 focus 기본선
- en/ko에서 같은 정보 구조와 시각적 일관성

### 단계 12 — 출시 경계 전체 검증 1회

모든 표적 묶음이 닫힌 뒤 루트에서 build·test·lint·security를 직렬로 한 번 실행합니다. 저장소의 package script와 CI 설정을 먼저 확인해 정본 명령을 사용하세요. 과거 명령을 추측해 병렬 실행하지 마세요.

전체 결과와 실제 Tauri 증거를 기록한 뒤에만 목표 완료 여부를 판단합니다.

## 11. 완료 정의(Definition of Done)

아래 항목이 모두 실제 증거로 충족되기 전에는 “AAA v1 완료” 또는 목표 `complete`를 선언하지 않습니다.

- [ ] 최신 번들의 command HTTP/UI 응답이 3초 이내이며 transaction warning 회귀 없음
- [ ] Codex 안전 fallback truth table 전체 통과
- [ ] queued/running orphan execution 없음
- [ ] 실제 환불 Work가 자연어 요청 하나로 완료
- [ ] Runtime Agent의 실제 위임·답변이 협업방에 인과·실행 계보와 함께 기록
- [ ] 별도 capability-gap Work가 명시적 배치 지시 없이 동적 Agent를 제안·승인·참여시킴
- [ ] 동적 Agent·모델 계보·협업방·인계·Task가 실제 데이터로 연결
- [ ] `refund-delay-report.md`의 계산과 rollback이 원본과 일치
- [ ] ArtifactVersion·Assurance·Records 완료
- [ ] 재시작 후 전체 상태 보존
- [ ] 지식 K01–K04와 관계 graph·citation·memory 적용/해제의 실제 workspace UAT 통과
- [ ] Growth 근거·평가·review/auto 채택·후속 효과·revert 완주
- [ ] Provider 연결·공급 모델·enable/disable·unavailable·fallback 계약 완주
- [ ] 예산 한도·임계값·route_attempt 비용 계보·실제 hard limit 차단 완주
- [ ] Extension Capability가 실제 Agent Runtime Work에 기여하고 권한·제거 보존
- [ ] 조직 proposal 승인·거절·version·revert와 홈·업무·수신함 단일 상태 원천 일치
- [ ] en/ko 시스템 기본·설정 전환·재시작 보존·동적 문구 일관성
- [ ] 15분 빠른 gate와 더 긴 bounded soak 모두에서 비정상 slope·peak 없음, 원시 sample evidence 보존
- [ ] 정상 종료 시 app/bridge/server와 Surreal 재사용·종료 수명주기 계약 통과
- [ ] bounded negative scenario matrix 전체 통과
- [ ] 실제 Tauri 화면이 fixture에 준하는 풍부함·일관성·접근성 확보
- [ ] root 직렬 전체 build/test/lint/security 통과
- [ ] 모든 원자 변경이 영어 Conventional Commit으로 커밋·푸시됨
- [ ] tag 없음

## 12. 실패하거나 오해하기 쉬운 접근

- fixture의 풍부한 activity를 실제 room message로 재포장해 성공처럼 보이게 하지 마세요.
- 모델 이름을 representative 결과 하나로 덮어 실제 planning attempt를 숨기지 마세요.
- fallback을 만들기 위해 router의 side-effect 보안 gate를 완화하지 마세요.
- 429 하나만 고치고 5xx·stream·schema·tool side-effect 형제를 다음 검수로 미루지 마세요.
- 저장된 데이터가 없는 출시 판단·워크숍 문서를 모델에게 작성시키고 UAT 성공으로 계산하지 마세요.
- 프롬프트에 `계획·실행·검증·기록을 완료하세요`, `동적 Agent를 배치하세요` 같은 내부 동작을 직접 지시하지 마세요.
- 백엔드 변경마다 시각 검수나 전체 build를 반복하지 마세요.
- 여러 에이전트가 공유 `dist`를 동시에 빌드하지 마세요.
- 앱 종료 후 orphan DB를 원인 확인 없이 kill/delete하지 마세요.
- 전체 목표를 일부 package test 통과만으로 완료 처리하지 마세요.

## 13. 핵심 코드·문서 지도

| 영역 | 위치 |
|---|---|
| Application command/projector 경계 | `packages/application/src/product.ts` 및 인접 테스트 |
| 실제 협업 pipeline | `packages/application/src/core-pipeline.ts` |
| Agent 협업 runtime GAP 계약 | `docs/phases/30-surface-parity-agent-ux/agent-collaboration-runtime-handoff.md` |
| Surreal transaction | storage package의 Massion database 구현 및 transaction 테스트 |
| Codex adapter | `apps/server/src/codex-app-server-agent.ts` |
| Codex adapter 테스트 | `apps/server/src/codex-app-server-agent.test.ts` |
| 모델 runner | `packages/runtime/src/voltagent-runner.ts` |
| runner 테스트 | `packages/runtime/src/voltagent-runner.test.ts` |
| router 보안 gate | `packages/router/src/model-router.ts` |
| Hugging Face Provider | `apps/server/src/deepseek-community-provider.ts` |
| Desktop product projection/copy | `apps/desktop/src/desktop-service.ts` |
| Desktop UI | `apps/desktop/src/app.tsx` |
| 현재 phase 문서 | `docs/phases/30-surface-parity-agent-ux/` |
| 실제 시험 프로젝트 | `/tmp/massion-refund-project-20260804` |
| Tauri bundle | `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app` |

라인 번호는 후속 수정으로 바뀔 수 있으므로 함수·테스트 이름과 `rg`로 다시 찾으세요.

## 14. 다음 에이전트에게 전달할 시작 지시문

아래 문구를 그대로 전달해도 됩니다.

```text
이 저장소의 docs/phases/30-surface-parity-agent-ux/aaa-v1-continuation-handoff-2026-08-05.md를 정본 인계서로 읽고 Massion AgentOS AAA v1 목표를 재개하세요. 목표는 완료가 아니라 paused 상태입니다. 질문하지 말고 먼저 Git·runtime 기준선을 검증한 뒤, 문서의 단계 1인 최신 Tauri 번들의 command 응답 재검증부터 시작하세요. 그 결과가 통과하면 새 범위를 열지 말고 Codex fallback·queued orphan·실제 모델 계보 묶음과 Runtime Agent 협업방 배선 묶음을 각각 RED→최소 구현→표적 테스트·포맷→통합 독립 검수→일괄 수정→최종 재검수→영어 Conventional Commit·push 순으로 닫으세요. build는 root 단일 직렬 큐에서만 실행하고 TUI·레거시 Web·비차단 미관 작업은 제외하세요. 이후 /tmp/massion-refund-project-20260804의 자연스러운 요청으로 Task·Artifact·Assurance·Records 완주를 검증하고, 별도 실제 파일 프로젝트에서 조직 capability gap을 먼저 증명한 뒤 명시적 배치 지시 없이 동적 Agent의 제안·승인·협업 참여·기여 계보를 검증하세요. 이것은 첫 임계 이정표일 뿐 전체 완료가 아닙니다. 이후 단계 9의 지식·조직·Growth·확장·Provider·예산·설정 계약과 단계 10의 negative matrix까지 실제 증거로 닫으세요. fixture는 기대 품질 기준이지 실제 증거가 아닙니다. 전체 완료 전 goal을 complete로 바꾸지 마세요.
```

## 15. 인계 시점의 목표 상태

현재 goal 도구에 저장된 목표는 복구되어 있지만 상태 값은 `paused`입니다. 제품 완료 조건이 충족된 것이 아니며, 다음 에이전트는 같은 objective를 활성 상태로 재개해야 합니다. 이 인계서는 작업을 종료하는 문서가 아니라 같은 목표를 다른 에이전트가 손실 없이 이어받기 위한 checkpoint입니다.
