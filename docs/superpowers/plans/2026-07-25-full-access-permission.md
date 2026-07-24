# 개인용 v1 전체 권한 실행 Implementation Plan

> **For agentic workers:** 이 계획은 `executing-plans`로 Task 순서대로 실행합니다. `full-access`를 UI preset으로 위장하지 말고, 실제 Governance·실행기·취소 경로가 같은 mode revision을 사용하게 합니다.

**Goal:** 사용자가 설정에서 한 번 경고를 확인하고 선택한 `full-access`를 Governance, Codex, Claude, 내장 Tool·MCP·Extension과 Growth에 실제 전달하고, 재시작 지속·해제·긴급 정지·UAT-P01~P02까지 완성합니다.

**Architecture:** 기존 `AutonomyStore`를 정본으로 확장하고 `GovernanceService.evaluate()`의 공통 판단 지점에서 tenant 정합성 뒤 권한 deny·approval을 우회합니다. 실행 시작 시 Work·RuntimeExecution과 subscription receipt에 mode/revision을 고정하고, 실제 구독 실행 정책은 `SubscriptionAgentPolicyResolver` 한 곳에서 Codex·Claude option으로 변환합니다. 모드 변경 orchestration은 `ApplicationProduct`가 내부 Run coordinator와 주입된 runtime/Growth port를 묶어 만들며, 기존 ApplicationRun retry·`VoltAgentRunner.cancel()`·긴급 정지를 재사용합니다. 해제 취소가 실패하면 긴급 정지를 영속해 새 실행을 막고 `limited`로 남깁니다.

**Tech Stack:** TypeScript 5.9, Vitest, SurrealDB 3.2.1, `@openai/codex-sdk@0.144.1`, `@anthropic-ai/claude-agent-sdk@0.3.207`, React 19, Tauri 2

---

## 1. 실행 위치와 범위

이 계획은 Phase 30 주 계획 Task 9까지와 `2026-07-25-growth-production-loop.md` Task 1~6이 끝난 뒤 실행합니다. 전체 권한 UAT-P02가 Growth 네 target을 검증하므로 Growth 생산 루프보다 먼저 완료로 표시할 수 없습니다.

v1에서 포함하는 최소 범위는 다음입니다.

1. `review | automatic | full-access` 저장·CAS·감사
2. Work·RuntimeExecution 시작 mode/revision 계보
3. Codex `danger-full-access + never`, Claude `bypassPermissions + allowDangerouslySkipPermissions`
4. 내장 Tool·MCP·Extension의 행동별 Governance prompt 생략
5. 활성 실행 회수, 승인 대기 재평가, 긴급 정지
6. 설정 경고·활성/제한 상태와 UAT-P01~P02

v1에서 만들지 않는 것은 다음과 같습니다.

- 시간 제한 preset, 권한별 행렬, 스케줄 자동 전환
- macOS root·SIP·TCC 우회
- Renderer에 shell·filesystem·daemon token 제공
- Web·TUI의 전체 권한 UI 유지보수 — 개인용 v1 정본은 desktop입니다.
- full-access를 켰다는 이유로 홈 디렉토리 전체를 RAG 색인

## 2. 변경하지 않는 정확성 경계

전체 권한에서도 다음은 그대로 실패해야 합니다.

- tenant identity와 요청 organization 불일치
- schema, revision, checksum, CAS, command ID 멱등성
- Work 완료 기준, Assurance, Records와 Runtime lineage
- Growth 독립 평가, explicit memory 충돌, 효과 표본, suspended/revert
- macOS 계정·Provider·설치 Capability 자체의 외부 제한

긴급 정지 활성 상태는 `GovernanceGate`의 policy 판단보다 먼저 실행을 차단합니다. 전체 권한이 긴급 정지를 무효화하지 않습니다.

## 3. 최소 테스트 원칙

사전 자동 검사는 다음 네 표만 추가합니다.

1. 동일 위험 행동 × 세 mode의 Governance 결과·mode revision·tenant/멱등 경계
2. Work·RuntimeExecution의 시작 snapshot과 immutable 계보
3. Codex·Claude의 정확한 SDK option과 미지원 connector의 `limited`
4. mode revoke·pending run 재평가·긴급 정지·Growth 네 target

파일·명령·네트워크 행동별 unit test를 반복하지 않습니다. 실제 앱 UAT에서 실패한 공통 경로에만 회귀 테스트 한 건을 추가합니다.

## Task 1: Autonomy 저장과 Governance 결정 계보 확장

**Files:**

- Modify: `packages/governance/src/autonomy.ts`
- Modify: `packages/governance/src/autonomy.test.ts`
- Modify: `packages/governance/src/schema.ts`
- Modify: `packages/governance/src/governance-service.ts`
- Modify: `packages/governance/src/governance-service.test.ts`
- Modify: `packages/governance/src/contracts.ts`
- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/adapters/domain.ts`
- Modify: `packages/application/src/adapters/domain.test.ts`
- Modify: `packages/application/src/query-registry.ts`

- [ ] **Step 1: 세 mode의 공통 판단 표를 먼저 실패시킵니다.**

같은 `tool.call` 요청에 대해 다음을 한 표에서 검사합니다.

- `review`: 비읽기 allow를 승인 요구로 승격
- `automatic`: 기존 Cedar deny·requirement 유지
- `full-access`: tenant 검증 뒤 allow, requirement 없음, reason `full-access-user-opt-in`
- 세 mode 모두 같은 command ID의 다른 request, tenant mismatch를 거부

- [ ] **Step 2: additive migration `0111-governance-full-access`을 추가합니다.**

기존 `0108-governance-autonomy` 본문을 수정하지 않습니다.

```sql
DEFINE FIELD OVERWRITE mode ON governance_autonomy
  TYPE string ASSERT $value IN ["automatic", "review", "full-access"];

DEFINE FIELD autonomy_mode ON governance_policy_decision
  TYPE option<string> ASSERT $value = NONE OR $value IN ["automatic", "review", "full-access"];
DEFINE FIELD autonomy_revision ON governance_policy_decision
  TYPE option<int> ASSERT $value = NONE OR $value >= 0;
```

과거 decision row는 optional을 유지합니다. 새 `evaluate()` 결과는 두 필드를 항상 기록하고 `reasons_json`에 우회 이유를 남깁니다. 별도 bypass table은 만들지 않습니다.

- [ ] **Step 3: `AutonomyMode`와 owner 경계를 확장합니다.**

```ts
export type AutonomyMode = "automatic" | "review" | "full-access";
```

기본값 `automatic`과 revision 0/최초 저장 1은 유지합니다. 세 mode 사이의 모든 변경은 owner만 허용하며 admin도 `automatic`이나 `full-access`로 승인 경계를 낮출 수 없습니다. `get()`은 선택적 `QueryExecutor`를 받아 Work·Runtime transaction에서 같은 상태를 읽을 수 있게 합니다.

- [ ] **Step 4: 판단 순서를 공통 경로에서 바꿉니다.**

```text
verify TenantContext
→ command replay/hash 확인
→ request principal/resource organization 확인
→ AutonomyState 한 번 조회
→ full-access: allow + reason 기록
→ 그 외: 기존 active policy·Cedar·requirement·review 조임
```

`GovernanceGate.authorize()`의 emergency check는 이 순서 앞에 그대로 둡니다. `full-access`가 active policy 부재를 우회하는 것은 허용하지만 tenant mismatch를 우회하면 안 됩니다.

- [ ] **Step 5: Application 공개 계약을 세 mode로 맞춥니다.**

`GovernanceAutonomyViewV1`과 `governance.autonomy.set` payload를 세 mode로 확장합니다. 이 command는 Desktop 사용자 제어 경로에만 등록하고 Agent tool catalog에는 넣지 않습니다. 실제 경고 확인은 Renderer가 command 호출 전에 수행하며, 성공한 `full-access` 저장 event 자체가 사용자 선택 근거입니다.

- [ ] **Step 6: 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/governance test -- autonomy.test.ts governance-service.test.ts
pnpm --filter @massion/governance typecheck
pnpm --filter @massion/application test -- adapters/domain.test.ts query-registry.test.ts
git add packages/governance/src/autonomy.ts packages/governance/src/autonomy.test.ts packages/governance/src/schema.ts packages/governance/src/governance-service.ts packages/governance/src/governance-service.test.ts packages/governance/src/contracts.ts packages/application/src/contracts.ts packages/application/src/adapters/domain.ts packages/application/src/adapters/domain.test.ts packages/application/src/query-registry.ts
git commit -m "feat(governance): 전체 권한 상태와 결정 계보 추가" \
  -m "세 번째 자율성 모드를 additive migration과 CAS로 저장하고 tenant 정합성을 유지한 채 권한 판단 우회를 감사 기록에 남깁니다."
```

## Task 2: Work·RuntimeExecution 시작 mode/revision 고정

**Files:**

- Modify: `packages/work/src/schema.ts`
- Modify: `packages/work/src/work.ts`
- Modify: `packages/work/src/work.test.ts`
- Modify: `packages/runtime/src/schema.ts`
- Modify: `packages/runtime/src/execution-store.ts`
- Modify: `packages/runtime/src/execution-store.test.ts`
- Modify: `packages/runtime/src/model-factory.ts`
- Modify: `packages/runtime/src/model-factory.test.ts`
- Modify: `packages/runtime/src/subscriptions/execution-receipt.ts`
- Modify: `packages/runtime/src/subscriptions/execution-receipt.test.ts`
- Modify: `packages/runtime/src/voltagent-runner.ts`
- Modify: `packages/runtime/src/voltagent-runner.test.ts`
- Modify: `apps/server/src/product.ts`
- Modify: `apps/server/src/product.test.ts`
- Modify: `packages/application/src/adapters/read-model.ts`
- Modify: `packages/application/src/contracts.ts`

- [ ] **Step 1: 시작 snapshot의 replay 경계를 먼저 고정합니다.**

한 Work·Runtime 테스트에서 `full-access` revision N으로 생성한 뒤 전역 mode를 바꾸고 다음을 확인합니다.

- 기존 Work·Execution은 N을 유지
- 새 Work·Execution은 새 mode/revision 사용
- 같은 command replay는 현재 mode가 달라져도 원래 aggregate를 반환
- 저장된 mode/revision UPDATE는 DB invariant로 거부

- [ ] **Step 2: additive migration 두 개를 추가합니다.**

`0112-work-autonomy-lineage`:

```sql
DEFINE FIELD autonomy_mode ON work TYPE option<string>
  ASSERT $value = NONE OR $value IN ["automatic", "review", "full-access"];
DEFINE FIELD autonomy_revision ON work TYPE option<int>
  ASSERT $value = NONE OR $value >= 0;
```

`0113-runtime-autonomy-lineage`도 같은 두 필드를 `runtime_execution`에 추가합니다. 두 migration의 event는 기존 row의 `NONE`을 허용하되 값이 한 번 저장되면 변경·부분 저장을 거부합니다.

- [ ] **Step 3: store constructor에 함수 하나만 주입합니다.**

새 registry나 package 의존성은 만들지 않습니다.

```ts
type AutonomySnapshotReader = (
  context: TenantContext,
  executor: QueryExecutor,
) => Promise<{ readonly mode: "automatic" | "review" | "full-access"; readonly revision: number }>;
```

server는 `(context, executor) => autonomy.get(context, executor)`를 `WorkService`와 `RuntimeExecutionStore`의 마지막 optional 인자로 전달합니다.

- [ ] **Step 4: replay 확인 뒤 같은 transaction에서 snapshot을 읽습니다.**

`createWork`, follow-up, fork는 각각 새 시작 시점의 mode/revision을 저장합니다. 부모 값을 상속하지 않습니다. `createExecution()`도 command replay를 먼저 확인한 뒤 current state를 읽어 row와 최초 event result에 함께 기록합니다. caller payload로 mode를 받지 않습니다.

- [ ] **Step 5: subscription receipt에도 같은 실행 권한 계보를 고정합니다.**

model binding이 확정한 redacted permission summary의 `autonomyMode`, `autonomyRevision`, `permissionMode`를 runtime binding → lease → 모든 subscription receipt event에 전달합니다. `SubscriptionExecutionReceiptCoordinator`는 caller 값만 믿지 않고 연결된 RuntimeExecution의 mode/revision과 같은지 검사합니다. acquire·start·checkpoint·terminal·settlement 중 하나라도 다르면 기록을 거부합니다.

- [ ] **Step 6: read-only projection에 계보를 노출합니다.**

Work 상세과 Runtime lineage view에는 사람이 읽는 `autonomyMode`, `autonomyRevision`을 추가합니다. 과거 row의 `NONE`은 `legacy-unknown` 상태로 정직하게 표시하고 현재 mode로 위장하지 않습니다.

- [ ] **Step 7: 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/work test -- work.test.ts
pnpm --filter @massion/runtime test -- execution-store.test.ts model-factory.test.ts subscriptions/execution-receipt.test.ts voltagent-runner.test.ts
pnpm --filter @massion/server test -- product.test.ts
pnpm --filter @massion/application typecheck
git add packages/work/src/schema.ts packages/work/src/work.ts packages/work/src/work.test.ts packages/runtime/src/schema.ts packages/runtime/src/execution-store.ts packages/runtime/src/execution-store.test.ts packages/runtime/src/model-factory.ts packages/runtime/src/model-factory.test.ts packages/runtime/src/subscriptions/execution-receipt.ts packages/runtime/src/subscriptions/execution-receipt.test.ts packages/runtime/src/voltagent-runner.ts packages/runtime/src/voltagent-runner.test.ts apps/server/src/product.ts apps/server/src/product.test.ts packages/application/src/adapters/read-model.ts packages/application/src/contracts.ts
git commit -m "feat(lineage): Work와 실행의 전체 권한 revision 기록" \
  -m "Work와 RuntimeExecution 생성 transaction에서 자율성 snapshot을 고정해 이후 모드 변경과 무관한 감사 계보를 보존합니다."
```

## Task 3: 실행 정책을 Codex·Claude에 정확히 전달

**Files:**

- Modify: `apps/server/src/subscription-governance.ts`
- Modify: `apps/server/src/subscription-governance.test.ts`
- Modify: `apps/server/src/subscription-runtime-resolver.ts`
- Modify: `apps/server/src/subscription-runtime-resolver.test.ts`
- Modify: `packages/runtime/src/subscriptions/codex-connector.ts`
- Modify: `packages/runtime/src/subscriptions/codex-connector.test.ts`
- Modify: `packages/runtime/src/subscriptions/claude-connector.ts`
- Modify: `packages/runtime/src/subscriptions/claude-connector.test.ts`

- [ ] **Step 1: 번들 SDK 타입을 먼저 확인합니다.**

```sh
rg -n 'danger-full-access|approvalPolicy' node_modules/.pnpm/@openai+codex-sdk@0.144.1*/node_modules/@openai/codex-sdk/dist/index.d.ts
rg -n 'bypassPermissions|allowDangerouslySkipPermissions' node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.207*/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

Expected: Codex `SandboxMode`와 Claude 두 option이 pinned declaration에 존재합니다. package를 업그레이드하지 않습니다.

- [ ] **Step 2: resolver의 유효 정책을 확장합니다.**

```ts
export interface SubscriptionAgentExecutionPolicy {
  readonly permissionMode: "governed" | "full-access";
  readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "never" | "on-request" | "deny";
  readonly networkAccessEnabled: boolean;
  readonly autonomyRevision: number;
}
```

`SubscriptionAgentPolicyResolver`가 AutonomyStore를 읽고 `full-access`일 때 정확히 다음을 반환합니다.

```ts
{
  permissionMode: "full-access",
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  networkAccessEnabled: true,
  autonomyRevision: state.revision,
}
```

일반 mode는 기존 subscription approval policy와 workspace read/write 계산을 유지합니다.

- [ ] **Step 3: Codex connector의 의도적 금지를 제거합니다.**

`Exclude<SandboxMode, "danger-full-access">`와 runtime validator를 넓히고 `startThread()`에 `danger-full-access`, `never`, network true가 그대로 전달되는지 spy 하나로 확인합니다. `on-request`는 계속 Codex app-server + Governance bridge를 사용하고, full-access는 SDK connector를 사용합니다.

- [ ] **Step 4: Claude options를 discriminated union으로 바꿉니다.**

```ts
type ClaudeSubscriptionConnectorOptions =
  | {
      readonly permissionMode: "default" | "auto" | "dontAsk" | "plan";
      readonly sandbox: NonNullable<Options["sandbox"]>;
      readonly allowDangerouslySkipPermissions?: never;
      readonly model?: string;
      readonly executable?: string;
    }
  | {
      readonly permissionMode: "bypassPermissions";
      readonly allowDangerouslySkipPermissions: true;
      readonly sandbox?: never;
      readonly model?: string;
      readonly executable?: string;
    };
```

full-access branch는 SDK `sandbox`, Massion `PreToolUse` hooks와 `canUseTool`을 모두 생략합니다. 일반 branch의 fail-closed sandbox와 bridge는 그대로 유지합니다. 단순 permissionMode 변경만 하고 Massion hook을 남기면 안 됩니다.

- [ ] **Step 5: 첫 full-access 초기화를 실제 capability probe로 사용합니다.**

정적 타입 검색은 빌드 전 drift 검사일 뿐 실제 capability 판정이 아닙니다. 선택된 Codex·Claude connector가 prompt를 보내기 전에 full-access option으로 SDK session을 초기화하고, option·override executable이 이를 거부하면 typed `full-access-unsupported` 결과로 바꿔 실행을 시작하지 않습니다. bundled 또는 custom executable 어느 쪽이든 초기화 성공 뒤에만 해당 adapter를 `full-access`로 투영하며, 초기화 거부 사례를 connector별 한 건씩 검사합니다.

- [ ] **Step 6: 미지원 connector를 정직하게 제한합니다.**

개인 local v1에서 exact full-access 지원 adapter는 Codex·Claude입니다. ACP·edge connector가 선택되면 restricted mode로 조용히 실행하지 않고 `SubscriptionAgentRuntimeResolver`가 typed unsupported error로 실행을 block합니다. Task 5의 공용 capability 판정 함수가 같은 adapter ID를 `limited` 이유로 투영하며, 이를 승인 팝업으로 대체하지 않습니다.

- [ ] **Step 7: 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/runtime test -- subscriptions/codex-connector.test.ts subscriptions/claude-connector.test.ts
pnpm --filter @massion/server test -- subscription-governance.test.ts subscription-runtime-resolver.test.ts
pnpm --filter @massion/runtime typecheck
pnpm --filter @massion/server typecheck
git add apps/server/src/subscription-governance.ts apps/server/src/subscription-governance.test.ts apps/server/src/subscription-runtime-resolver.ts apps/server/src/subscription-runtime-resolver.test.ts packages/runtime/src/subscriptions/codex-connector.ts packages/runtime/src/subscriptions/codex-connector.test.ts packages/runtime/src/subscriptions/claude-connector.ts packages/runtime/src/subscriptions/claude-connector.test.ts
git commit -m "feat(runtime): 전체 권한을 Codex와 Claude에 전달" \
  -m "공통 자율성 revision을 Codex danger-full-access와 Claude bypassPermissions로 변환하고 미지원 connector는 제한됨으로 차단합니다."
```

## Task 4: mode 회수·승인 대기 재평가·긴급 정지 연결

**Files:**

- Create: `packages/application/src/autonomy-transition-coordinator.ts`
- Create: `packages/application/src/autonomy-transition-coordinator.test.ts`
- Modify: `packages/application/src/run-store.ts`
- Modify: `packages/application/src/run-store.test.ts`
- Modify: `packages/application/src/command-store.ts`
- Modify: `packages/application/src/command-store.test.ts`
- Modify: `packages/application/src/core-work-coordinator.ts`
- Modify: `packages/application/src/core-work-coordinator.test.ts`
- Modify: `packages/application/src/product.ts`
- Modify: `packages/application/src/product.test.ts`
- Modify: `packages/runtime/src/voltagent-runner.ts`
- Modify: `packages/runtime/src/voltagent-runner.test.ts`
- Modify: `packages/runtime/src/execution-store.ts`
- Modify: `packages/runtime/src/execution-store.test.ts`
- Modify: `packages/governance/src/emergency.ts`
- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/adapters/domain.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `apps/server/src/product.ts`

- [ ] **Step 1: 한 transition 통합 표를 먼저 실패시킵니다.**

다음을 같은 server test에 넣습니다.

- `automatic → full-access`: pending ApplicationRun의 provider 실행을 취소하고 같은 run command 계보에서 새 stage attempt 실행, old approval cancelled
- `full-access → review`: 조직의 active·suspended runtime 전부 취소, 이후 새 위험 행동은 approval 대기
- 해제 중 connector 취소 실패: 새 mode는 저장되지만 긴급 정지가 active이고 상태는 `limited`; 남은 old-revision 실행을 재시도해 없애기 전에는 새 실행 차단
- 긴급 정지: mode와 무관하게 active runtime 취소, 이후 부작용 차단
- 권한과 무관한 blocked run은 자동 retry하지 않음

- [ ] **Step 2: 기존 retry 필드를 승인 재평가에도 재사용합니다.**

새 continuation table을 만들지 않습니다. `ApplicationRunStore.claim()`에 `reevaluateAwaitingApproval` option을 추가해 다음 조건에서만 기존 `retry_attempt_id`를 설정합니다.

```text
status = awaiting-approval
AND approval_id = supplied approvalId
AND retryAttemptId = `autonomy:<newRevision>`
```

이 claim은 `approval_id`와 `resume_approval_id`를 지우고 current stage를 새 deterministic stage command ID로 실행합니다. 기존 `request_json`, run `command_id`, Work ID는 유지합니다. 승인 permit을 위조해 resume하지 않습니다.

- [ ] **Step 3: 실행과 독립된 Application command는 정직하게 다시 실행하도록 만듭니다.**

Registry 설치·Extension·Policy 변경처럼 `ApplicationRun`과 연결되지 않은 `application_command`는 원 payload가 저장되지 않으므로 자동 재개를 새 continuation 저장소로 확장하지 않습니다. `ApplicationCommandStore`가 `awaiting-approval` result의 approval ID를 읽어 그 approval을 취소하고 command를 `blocked` + `autonomy-changed-retry-required`로 CAS 전이합니다. 수신함은 `다시 실행 필요`로 소유 화면에 보내고, 사용자가 새 command ID로 다시 실행하면 현재 full-access 판단을 사용합니다.

- [ ] **Step 4: 조직 실행 취소를 기존 runner에 한 메서드로 추가합니다.**

`VoltAgentRunner.cancelOrganization(context, reason)`은 private active/suspended map에서 같은 organization의 execution ID를 모아 기존 `cancel()`을 `Promise.allSettled()`로 호출합니다. `shutdown()`과 달리 새 실행 수락을 끄지 않습니다. 실패는 `AggregateError`로 반환해 UI가 성공으로 위장하지 않게 합니다.

`RuntimeExecutionStore`에는 organization·`full-access` revision별 active/suspended 실행을 읽는 좁은 조회를 추가합니다. cancel 반환만 믿지 않고 이 조회가 빈 배열이어야 회수 완료로 판정합니다.

- [ ] **Step 5: Application transition coordinator를 조립합니다.**

`ApplicationProduct.create()`는 내부에서 만든 `ApplicationRunStore`·`CoreWorkCoordinator`와 server가 주입한 AutonomyStore·ApprovalStore·runtime cancellation·Growth reconciliation port를 `AutonomyTransitionCoordinator`에 전달합니다. 따라서 server가 아직 생성되지 않은 `application.coordinator`를 역참조하지 않습니다.

`AutonomyTransitionCoordinator.set()`의 순서는 다음과 같습니다.

```text
AutonomyStore CAS set
→ full-access 진입: pending approvals 분류
   → ApplicationRun/Runtime approval: old execution cancel → run reevaluate → approval cancel
   → Growth awaiting-review: GrowthWorker.reconcile(newRevision)
   → 독립 Application command: approval cancel → 다시 실행 필요로 차단
   → 권한과 무관한 blocker: 그대로 유지
→ full-access 해제: cancelOrganization("autonomy_revoked")
   → old full-access revision의 active/suspended 실행이 0인지 조회
   → 실패 또는 잔존 실행: EmergencyControl.activate(`autonomy-revoke:<revision>`) → limited
→ 결과에 mode/revision/reconciled/runtimePermissionStatus/limitedReason 반환
```

정상 제품의 runtime approval은 parent ApplicationRun과 연결돼 있어야 합니다. 연결이 없는 고아 runtime approval은 실행과 approval을 취소하고 `다시 실행 필요` 차단으로 남기며 full-access 재개 성공으로 기록하지 않습니다.

해제 실패의 원인은 새 전이 테이블 대신 기존 emergency state와 남은 RuntimeExecution row로 영속합니다. startup recovery와 `local.runtime.status` 조회 시 cancellation을 다시 시도하고, 잔존 실행이 없어져도 owner가 기존 permit 경로로 긴급 정지를 해제하기 전에는 새 실행을 허용하지 않습니다. 설정에 새 mode가 저장됐다는 사실만으로 정상 회수라고 표시하지 않습니다.

- [ ] **Step 6: 긴급 정지를 사용자 command에 연결합니다.**

`EmergencyControl.get()`을 추가하고 `governance.emergency`, `governance.emergency.activate` typed 계약을 등록합니다. activate 성공 직후 `cancelOrganization("emergency_stop")`을 호출합니다. 활성/해제 command는 owner desktop 경로에만 두고 Agent tool catalog에는 넣지 않습니다. 기존 release의 permit·revision 계약은 약화하지 않습니다.

- [ ] **Step 7: 다음 부작용의 current revision을 보장합니다.**

내장 Tool·MCP·Extension은 기존 `GovernanceGate.authorize()`가 매 행동마다 current AutonomyState를 읽습니다. Codex는 행동별 hook이 없고 Claude full-access는 의도적으로 hook을 제거하므로 mode 해제 때 active connector를 즉시 취소하는 것이 회수 경계입니다. 시작 snapshot만 보고 계속 실행하게 두지 않습니다.

- [ ] **Step 8: 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/application test -- run-store.test.ts command-store.test.ts core-work-coordinator.test.ts
pnpm --filter @massion/runtime test -- execution-store.test.ts voltagent-runner.test.ts
pnpm --filter @massion/application test -- autonomy-transition-coordinator.test.ts product.test.ts
pnpm --filter @massion/governance test -- emergency.test.ts
git add apps/server/src/product.ts packages/application/src/autonomy-transition-coordinator.ts packages/application/src/autonomy-transition-coordinator.test.ts packages/application/src/run-store.ts packages/application/src/run-store.test.ts packages/application/src/command-store.ts packages/application/src/command-store.test.ts packages/application/src/core-work-coordinator.ts packages/application/src/core-work-coordinator.test.ts packages/application/src/product.ts packages/application/src/product.test.ts packages/application/src/contracts.ts packages/application/src/adapters/domain.ts packages/application/src/query-registry.ts packages/runtime/src/execution-store.ts packages/runtime/src/execution-store.test.ts packages/runtime/src/voltagent-runner.ts packages/runtime/src/voltagent-runner.test.ts packages/governance/src/emergency.ts
git commit -m "feat(governance): 전체 권한 회수와 승인 재평가 연결" \
  -m "모드 전환과 긴급 정지가 활성 실행을 취소하고 승인만 남은 ApplicationRun을 같은 계보의 새 stage attempt로 재평가하게 했습니다."
```

## Task 5: Growth·내장 Tool·Extension에 유효 전체 권한 적용

**Files:**

- Modify: `packages/growth/src/adoption.ts`
- Modify: `packages/growth/src/adoption.test.ts`
- Modify: `packages/growth/src/revert.ts`
- Modify: `packages/growth/src/revert.test.ts`
- Modify: `apps/server/src/growth-worker.ts`
- Modify: `apps/server/src/growth-worker.test.ts`
- Modify: `apps/server/src/subscription-governance.test.ts`
- Modify: `packages/extension-host/src/gateway.test.ts`
- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `apps/server/src/product.ts`

- [ ] **Step 1: full-access의 Growth 유효 mode를 기존 authorization에서 계산합니다.**

```ts
const effectiveMode =
  authorization.decision.autonomyMode === "full-access"
    ? "auto"
    : configuration.adoptionMode;
```

저장된 Growth 설정은 바꾸지 않습니다. full-access 동안만 네 target의 eligible adoption·검증된 revert를 auto로 처리하고, 해제 뒤 기존 `review | auto` 설정으로 돌아갑니다.

- [ ] **Step 2: 정확성 guard가 그대로 실패하는지 확인합니다.**

네 target 표에서 full-access라도 다음을 거부합니다.

- independent signal 없음 또는 model-self만 있음
- stale source·target, suggestion revision mismatch
- explicit user memory 같은 key 충돌
- 잘못된 Effect sample lineage·checksum

- [ ] **Step 3: pending Growth를 worker가 재처리합니다.**

Task 4 coordinator가 `GrowthWorker.reconcile(newRevision)`을 호출하면 eligible `awaiting-review` suggestion/revert를 current mode로 다시 평가합니다. `GrowthAdoptionService`와 `GrowthRevertService`에 daemon 전용 `autonomyRevision` 재평가 입력을 추가하고, `${originalCommandId}:autonomy:${newRevision}` 결정으로 재인가한 뒤 새 row를 만들지 않고 기존 waiting row를 CAS로 전이합니다. full-access이면 approval ID 없이 target을 적용하고, 적용 성공 뒤 기존 pending approval을 결정적 command로 취소합니다. 중간 crash 뒤에는 이미 전이된 row와 남은 approval을 대조해 cancel만 재시도합니다.

- [ ] **Step 4: 내장 행동은 공통 Gate 한 건으로 검증합니다.**

설치된 최소 Extension tool 하나 또는 내장 Tool 하나를 사용해 `automatic`에서는 기존 policy requirement가 approval을 만들고, full-access에서는 같은 action이 approval 없이 실행되며 audit·Tool·Work 사건은 남는지 확인합니다. Tool별 별도 우회 코드를 만들지 않습니다.

- [ ] **Step 5: runtime status projection을 완성합니다.**

Phase 30 Task 9의 `local.runtime.status`에 다음을 확정합니다.

```ts
readonly autonomyMode: "review" | "automatic" | "full-access";
readonly autonomyRevision: number;
readonly runtimePermissionStatus: "governed" | "full-access" | "limited";
readonly permissionLimitReason?: string;
readonly emergencyStopActive: boolean;
```

선택된 connector가 exact option을 지원하지 않거나 cancellation/reconciliation이 실패하면 `limited`와 원인을 반환합니다. 해제 실패는 emergency state와 남은 old-revision RuntimeExecution에서 복원하고 재취소합니다. 숫자 0이나 full-access 성공으로 위장하지 않습니다.

- [ ] **Step 6: 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/growth test -- adoption.test.ts revert.test.ts
pnpm --filter @massion/server test -- growth-worker.test.ts subscription-governance.test.ts
pnpm --filter @massion/extension-host test -- gateway.test.ts
pnpm --filter @massion/application test -- query-registry.test.ts
git add packages/growth/src/adoption.ts packages/growth/src/adoption.test.ts packages/growth/src/revert.ts packages/growth/src/revert.test.ts apps/server/src/growth-worker.ts apps/server/src/growth-worker.test.ts apps/server/src/subscription-governance.test.ts packages/extension-host/src/gateway.test.ts packages/application/src/contracts.ts packages/application/src/query-registry.ts apps/server/src/product.ts
git commit -m "feat(growth): 전체 권한의 자동 채택을 정확성 경계에 연결" \
  -m "전체 권한 동안 네 Growth target과 내장 행동의 승인은 생략하되 평가·checksum·효과·감사 계보는 유지합니다."
```

## Task 6: Desktop 경고·상태·회수 UI 연결

**Files:**

- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/desktop-service.test.ts`
- Modify: `apps/desktop/src/app.tsx`
- Modify: `apps/desktop/src/app.integration.test.tsx`

- [ ] **Step 1: 경고 전에는 command가 호출되지 않는 테스트를 추가합니다.**

`automatic | review → full-access`에서 확인 전 호출 0회, 확인 후 현재 expectedRevision으로 정확히 1회 호출을 검사합니다. full-access 상태를 reload할 때는 경고가 없어야 하고, 해제 후 재진입하면 다시 정확히 한 번 떠야 합니다.

- [ ] **Step 2: 설계의 정확한 경고 문구를 사용합니다.**

> 에이전트가 현재 macOS 사용자와 같은 범위에서 파일을 읽고 변경·삭제하며, 명령과 네트워크 요청을 실행하고 연결된 계정과 확장을 사용할 수 있습니다. 그 결과에 대한 책임은 사용자에게 있습니다.

확인 뒤 행동별 경고를 추가하지 않습니다.

- [ ] **Step 3: 세 선택과 현재 상태를 typed service에 연결합니다.**

- 검토: 읽기가 아닌 행동에 사용자 승인 추가
- 자동: 정책이 허용한 범위에서 자동 실행
- 전체 권한: 현재 macOS 사용자 권한으로 실행

활성 시 `전체 권한 켜짐 · 현재 macOS 사용자 권한으로 실행`, connector별 `전체 권한 | 제한됨 | 사용 불가`, `전체 권한 끄기`를 표시합니다. `limitedReason`을 숨기지 않습니다.

- [ ] **Step 4: 긴급 정지를 같은 설정 블록에 둡니다.**

긴급 정지는 전체 권한 on/off와 별도 버튼이며 어느 mode에서도 즉시 실행합니다. confirmation은 파괴적 행동 한 번만 묻고, Agent나 수신함 항목이 대신 누를 수 없습니다.

- [ ] **Step 5: 수신함 정합성을 확인합니다.**

full-access가 허용한 새 행동은 approval item을 만들지 않습니다. 전환 전에 존재한 승인 item은 reconciliation 완료 뒤 제거되고, 실제 OS·Provider·Capability 실패는 `차단`으로 남아 소유 화면으로 이동합니다.

- [ ] **Step 6: 검증하고 커밋합니다.**

```sh
pnpm exec eslint apps/desktop/src
pnpm --filter @massion/desktop typecheck
pnpm --filter @massion/desktop test
git add apps/desktop/src/desktop-service.ts apps/desktop/src/desktop-service.test.ts apps/desktop/src/app.tsx apps/desktop/src/app.integration.test.tsx
git commit -m "feat(desktop): 전체 권한 선택과 실행 상태 표시" \
  -m "정확한 사용자 책임 경고 뒤 전체 권한을 저장하고 재시작 지속·제한 원인·해제·긴급 정지를 같은 설정 표면에 연결했습니다."
```

## Task 7: 실제 UAT-P01~P02와 추적 근거 확정

**Files:**

- Create: `docs/evidence/phase-30/full-access-uat-2026-07-25.md`
- Modify: `docs/generated/requirements-traceability.tsv`
- Modify: `PRODUCT.md`
- Modify: `docs/product/constitution.md`

- [ ] **Step 1: 같은 후보 SHA에서 표적 gate를 실행합니다.**

```sh
pnpm --filter @massion/governance test
pnpm --filter @massion/work test
pnpm --filter @massion/runtime test
pnpm --filter @massion/growth test
pnpm --filter @massion/application test
pnpm --filter @massion/server test
pnpm --filter @massion/desktop test
pnpm --filter @massion/desktop typecheck
```

- [ ] **Step 2: 격리된 macOS 테스트 계정에서 UAT-P01을 실행합니다.**

임시 Workspace의 형제 디렉터리에서 marker 읽기, 새 파일 쓰기·그 파일만 삭제, 하위 프로세스, 로컬 HTTP, 설치된 Tool 하나를 실제 Work로 실행합니다. 승인 팝업·수신함 approval이 없어야 하며 Work·Runtime·Tool 사건의 mode/revision이 같아야 합니다.

- [ ] **Step 3: UAT-P02를 실행합니다.**

재시작 지속, eligible Growth 자동 채택, 부적격 후보 거부, 실행 중 해제·새 review approval, 재진입 경고 정확히 한 번, 긴급 정지 뒤 부작용 중단을 모두 확인합니다.

- [ ] **Step 4: read-only 계보와 실제 connector option을 대조합니다.**

AutonomyState, GovernanceDecision, Work, RuntimeExecution, subscription receipt가 같은 revision을 가리키는지 확인합니다. Codex·Claude는 선택된 실행의 redacted policy summary만 기록하고 환경 변수·키·prompt 원문은 evidence에 남기지 않습니다.

- [ ] **Step 5: 추적표와 제품 문서를 실제 값으로 갱신하고 커밋합니다.**

`REQ-FULL-ACCESS-001`, `REQ-FULL-ACCESS-UAT-001`의 tests·commits·events·metrics·evidence를 실제 값으로 바꾸고 모든 조건을 충족한 행만 `completed`로 표시합니다.

```sh
git add docs/evidence/phase-30/full-access-uat-2026-07-25.md docs/generated/requirements-traceability.tsv PRODUCT.md docs/product/constitution.md
git commit -m "docs(phase-30): 전체 권한 실사용 근거 기록" \
  -m "격리된 실제 macOS 앱에서 파일·명령·네트워크·도구 실행과 재시작 지속·회수·긴급 정지를 같은 후보 SHA로 검증했습니다."
```

## 4. 완료 게이트

- [ ] 기본 `automatic`, Growth 기본 `review`가 유지됩니다.
- [ ] full-access 진입마다 정확한 경고를 한 번 확인하고 재시작 뒤에는 다시 묻지 않습니다.
- [ ] Governance deny·approval requirement와 Workspace 실행 sandbox가 실제로 우회됩니다.
- [ ] tenant·revision·checksum·멱등·Assurance·Records는 우회되지 않습니다.
- [ ] Work·RuntimeExecution·GovernanceDecision에 같은 시작 mode/revision이 남습니다.
- [ ] Codex와 Claude가 exact SDK option을 받고, 미지원 connector는 `limited`로 차단됩니다.
- [ ] 내장 Tool·MCP·Extension과 eligible Growth 네 target은 개별 approval 없이 실행됩니다.
- [ ] full-access 해제와 긴급 정지가 active·suspended 실행을 실제 취소합니다.
- [ ] 승인만 남은 ApplicationRun은 같은 run command 계보의 새 stage attempt로 재평가됩니다.
- [ ] 독립 Application command의 과거 승인은 취소되고 다시 실행 필요로 표시되며, 새 실행은 full-access에서 승인 없이 진행됩니다.
- [ ] UAT-P01~P02가 실제 빌드 후보에서 통과합니다.
