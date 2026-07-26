# 개인용 v1 지속 발전 생산 루프 Implementation Plan

> **For agentic workers:** 이 계획은 `executing-plans`로 Task 순서대로 실행합니다. 공용 파일은 해당 Task의 hunk만 stage하며, 새 worker framework를 만들지 않습니다.

**Goal:** 완료된 실제 Work를 근거로 Reflection → 독립 평가 → `review | auto` 채택 → 다음 Work 적용 → 검증된 효과 측정 → 노출 중단·되돌리기가 자동으로 이어지는 개인용 v1 생산 루프를 완성합니다.

**Architecture:** 이미 존재하는 `GrowthTriggerStore`, `ReflectionService`, `GrowthEvaluationStore`, `GrowthAdoptionService`, `GrowthEffectStore`, `GrowthRevertService`, Prompt·Memory·Policy·Organization target port를 그대로 사용합니다. 새 생산 코드는 daemon 내부 `GrowthWorker` 한 개뿐이며, 신뢰된 로컬 bootstrap이 돌려준 개인 조직 문맥에서 Records trigger와 중간 상태를 재개합니다. 모델은 현재 `RoutedAgentRunner.executeStructured()`를 사용하고, 효과 점수는 Renderer나 모델 입력이 아니라 terminal Assurance와 검증된 metric observation에서만 조립합니다. 성공 Work의 Records 계보는 함께 검증하되 실패한 Assurance 표본에는 존재를 강제하지 않습니다.

**Tech Stack:** TypeScript 5.9, Vitest, SurrealDB 3.2.1, VoltAgent routed runtime, React 19, Tauri 2

---

## 1. 실행 위치와 선행 조건

이 계획은 다음 작업이 끝난 뒤 실행합니다.

1. `2026-07-25-knowledge-memory-integration.md` Task 1~6
2. Phase 30 주 계획 Task 4의 Core Work·Assurance·Records 실제 완주
3. Phase 30 주 계획 Task 5의 협업 출처 기록
4. Phase 30 주 계획 Task 6의 Organization 실 projection

따라서 개인 explicit memory CRUD와 `GrowthWorkPromptAdapter`·`GrowthAgentConfigurationReader` 생산 주입은 이 계획에서 다시 만들지 않습니다. 선행 커밋이 없으면 Task 1을 시작하지 않고 지식·기억 계획으로 돌아갑니다.

v1에서 만들지 않는 것은 다음과 같습니다.

- 범용 queue·job framework와 별도 Growth daemon
- 사용자 정의 평가 DSL·임계값 편집기
- 문장 단위 의미 그래프와 자동 semantic memory 추출
- 모델이 직접 넣은 raw 효과 점수
- 여러 후보를 동시에 노출하는 실험 플랫폼

## 2. 확인된 코드 공백

| 공백 | 현재 근거 | 이 계획의 소유 Task |
|---|---|---|
| 생산 worker 없음 | `GrowthTriggerStore` 사용처가 테스트뿐 | Task 2~3 |
| Reflection 생성·근거 검증이 항상 throw | `apps/server/src/product.ts`의 임시 adapter | Task 2 |
| Reflection run에 RuntimeExecution ID가 기록되지 않음 | `ReflectionService.run()`은 optional field를 쓰지 않음 | Task 1~2 |
| `suggestionRevision`이 실제 suggestion과 비교되지 않음 | 입력에는 있으나 schema·CAS 없음 | Task 1 |
| 효과 입력이 raw score·count뿐 | Work·Assurance·Records ID/checksum 없음 | Task 3 |
| suspended target이 새 Work에 노출될 수 있음 | effect는 adoption만 suspend하고 prompt compose는 active를 읽음 | Task 1·3 |
| 제품 계약·데스크톱 결정 행동 미연결 | query가 세부 계보를 버리고 버튼은 disabled | Task 4~5 |

## 3. 최소 테스트 원칙

사전 자동 검사는 다음 세 묶음만 추가합니다.

1. 한 migration/CAS 표: Reflection runtime lineage, suggestion revision, suspended target 거부
2. 한 서버 통합 표: 네 target × `review | auto`, 독립 신호 없는 후보와 checksum drift 거부
3. 한 효과 표: 검증된 baseline/observation만 허용하고 `improved | stable`은 guard 해제, `degraded`는 다음 Work 노출 중단·복원

컴포넌트 문구, worker 내부 함수, 정상 store 호출마다 unit test를 만들지 않습니다. 실제 UAT 실패가 나오면 가장 낮은 공통 원인에 회귀 테스트 한 건만 추가합니다.

## Task 1: 생산 계보와 노출 차단 경계 보강

**Files:**

- Modify: `packages/growth/src/schema.ts`
- Modify: `packages/growth/src/reflection.ts`
- Modify: `packages/growth/src/reflection.test.ts`
- Modify: `packages/growth/src/adoption.ts`
- Modify: `packages/growth/src/adoption.test.ts`
- Modify: `packages/growth/src/effect.ts`
- Modify: `packages/growth/src/effect.test.ts`
- Modify: `packages/growth/src/revert.ts`
- Modify: `packages/growth/src/work-prompt-adapter.ts`
- Modify: `packages/growth/src/work-prompt-adapter.test.ts`
- Modify: `packages/growth/src/index.ts`

- [ ] **Step 1: 선행 Prompt·Memory 생산 조립을 확인합니다.**

Run:

```sh
rg -n "GrowthWorkPromptAdapter|GrowthAgentConfigurationReader|AgentInstructionRegistry" apps/server/src/product.ts
pnpm --filter @massion/growth test -- work-prompt-adapter.test.ts runtime-configuration.test.ts
```

Expected: 세 생산 seam이 server 조립에 있고 표적 테스트 exit 0. 없으면 이 Task에서 임시 조립하지 않고 지식·기억 계획 Task 5를 먼저 완료합니다.

- [ ] **Step 2: 하나의 경계 표를 먼저 실패시킵니다.**

기존 테스트 파일에 다음만 한 표로 추가합니다.

- 완료 Reflection은 succeeded `agent_handle = "growth"` RuntimeExecution ID를 가져야 함
- 저장된 suggestion revision과 입력 revision이 다르면 adopt·revert 거부
- active Prompt·Memory·Policy·Organization version 중 하나라도 `exposure_status = "suspended"`이면 새 Work prompt 생성 거부
- `improved | stable` effect 뒤 기존 adoption guard가 풀려 같은 target의 다음 적격 후보를 채택할 수 있음

- [ ] **Step 3: base table 뒤에 적용되는 additive migration 두 개를 추가합니다.**

과거 migration을 수정하지 않습니다. Reflection 계보와 Effect 계보를 한 migration에 섞으면 먼저 생성되는 `ReflectionService`가 아직 없는 Effect table을 건드리므로 다음 두 migration으로 나눕니다.

- `0110-growth-production-reflection-lineage`: `GROWTH_REFLECTION_MIGRATION` 뒤 `ReflectionService.create()`가 적용
- `0110-growth-production-effect-lineage`: `GROWTH_EFFECT_REVERT_MIGRATION` 뒤 `GrowthEffectStore.create()`가 적용

기존 suggestion은 revision 1로 backfill한 뒤 필드를 필수화하고 사용자 결정 이유를 추가합니다. 이는 Reflection lineage migration 본문입니다.

```sql
DEFINE FIELD revision ON growth_suggestion TYPE option<int>;
UPDATE growth_suggestion SET revision = 1 WHERE revision = NONE;
DEFINE FIELD OVERWRITE revision ON growth_suggestion TYPE int ASSERT $value >= 1;
DEFINE FIELD decision_reason ON growth_suggestion TYPE option<string>;
DEFINE FIELD decided_by_user_id ON growth_suggestion TYPE option<string>;
DEFINE FIELD decided_at ON growth_suggestion TYPE option<datetime>;
```

Effect lineage migration에는 표본 계보와 terminal retained 상태만 추가합니다.

```sql
DEFINE FIELD sample_lineage_json ON growth_effect_baseline TYPE option<string>;
DEFINE FIELD sample_lineage_checksum ON growth_effect_baseline TYPE option<string>;
DEFINE FIELD sample_lineage_json ON growth_effect_observation TYPE option<string>;
DEFINE FIELD sample_lineage_checksum ON growth_effect_observation TYPE option<string>;
DEFINE FIELD OVERWRITE status ON growth_adoption_run
  TYPE string ASSERT $value IN ["awaiting-review", "observing", "retained", "rejected", "reverted"];
```

각 migration의 event는 다음만 고정합니다.

- completed Reflection의 `runtime_execution_id` 필수 및 이후 immutable
- suggestion의 내용·revision immutable, 상태·결정 정보만 허용된 전이에서 변경
- 효과 표본 계보 checksum은 저장 뒤 immutable
- `observing → retained`만 Effect `improved | stable`의 terminal 성공 전이로 허용

두 migration은 이를 소유한 store의 `create()` migration 목록에 각각 추가하고 루트 index에서 export합니다. 하나가 먼저 적용돼 다른 base table 보강이 건너뛰어지는 순서를 허용하지 않습니다.

- [ ] **Step 4: Reflection generator 결과에 실행 계보를 포함합니다.**

```ts
export interface GeneratedReflection {
  readonly runtimeExecutionId: string;
  readonly candidates: readonly SuggestionCandidate[];
}

export interface ReflectionGenerator {
  generate(
    context: TenantContext,
    input: { readonly reflectionRunId: string; readonly snapshot: ReflectionSnapshot },
  ): Promise<GeneratedReflection>;
}
```

`ReflectionService.run()`은 candidates를 저장하기 전에 RuntimeExecution의 tenant·Work·`growth` handle·`succeeded`를 검증합니다. generator 호출 전에 만든 `generating` row가 replay되면 같은 reflection ID와 snapshot으로 다시 생성하고, 완료 row만 즉시 반환합니다. 모든 candidate와 source를 먼저 검증한 다음 suggestion·source reference·`runtime_execution_id`·Reflection/trigger 완료·`growth_event`를 한 DB transaction에서 기록합니다. 따라서 process crash가 부분 suggestion을 남기지 않고 완료 commit 뒤 replay도 중복을 만들지 않습니다. 제안은 `revision: 1`로 생성합니다.

- [ ] **Step 5: 실제 revision 비교와 suspended fail-closed를 추가합니다.**

`GrowthAdoptionService`와 `GrowthRevertService`가 조회한 `growth_suggestion.revision`을 입력과 비교합니다. Adoption이 만드는 pending baseline의 `target_version_id`는 채택 전 cohort가 실제 사용한 `before_version_id`로 저장하고, observation만 `after_version_id`를 요구합니다. `GrowthWorkPromptAdapter.resolve()`는 prompt compose 직후 같은 transaction에서 아래 version 집합을 조회합니다.

```ts
const versionIds = [
  composed.promptDefinitionVersionId,
  ...composed.memoryVersionIds,
  composed.policyVersionId,
  composed.organizationVersionId,
].filter((value): value is string => value !== undefined);
```

이 중 `growth_adoption_run.after_version_id`가 같고 `exposure_status = "suspended"`인 row가 하나라도 있으면 transaction을 실패시킵니다. 별도 exposure registry는 만들지 않습니다.

- [ ] **Step 6: 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/growth test -- reflection.test.ts adoption.test.ts effect.test.ts work-prompt-adapter.test.ts
pnpm --filter @massion/growth typecheck
git add packages/growth/src/schema.ts packages/growth/src/reflection.ts packages/growth/src/reflection.test.ts packages/growth/src/adoption.ts packages/growth/src/adoption.test.ts packages/growth/src/effect.ts packages/growth/src/effect.test.ts packages/growth/src/revert.ts packages/growth/src/work-prompt-adapter.ts packages/growth/src/work-prompt-adapter.test.ts packages/growth/src/index.ts
git commit -m "feat(growth): 생산 계보와 노출 차단 경계 보강" \
  -m "Reflection 실행 ID와 Suggestion revision을 고정하고 suspended target이 새 Work에 들어가지 않도록 fail closed했습니다."
```

## Task 2: Records trigger를 실제 Reflection 실행에 연결

> **2026-07-26 증분:** `apps/server/src/growth-worker.ts`와 제품 조립이 연결되었습니다. 완료 Records backfill·lease claim·bounded Work snapshot·실제 structured Growth 실행·source/runtime 검증·Reflection 저장까지 구현했으며, 평가·채택·효과·복원은 Task 3 이후로 남아 있습니다. 전용 worker 통합 테스트와 실제 완료 Records→suggestion 데스크톱 UAT가 남아 있으므로 Task 2 전체 완료로 표시하지 않습니다.

**Files:**

- Create: `apps/server/src/growth-worker.ts`
- Create: `apps/server/src/growth-worker.test.ts`
- Modify: `packages/growth/src/snapshot.ts`
- Modify: `packages/growth/src/snapshot.test.ts`
- Modify: `packages/growth/src/trigger.ts`
- Modify: `packages/growth/src/trigger.test.ts`
- Modify: `packages/growth/src/index.ts`
- Modify: `packages/application/src/bootstrap.ts`
- Modify: `packages/application/src/bootstrap.test.ts`
- Modify: `packages/application/src/product.ts`
- Modify: `packages/application/src/product.test.ts`
- Modify: `apps/server/src/product.ts`
- Modify: `apps/server/src/product.test.ts`

- [ ] **Step 1: worker의 단일 tick 계약을 실패시킵니다.**

한 server 통합 테스트에서 finalized WorkRecord와 completed RecordsRun을 만든 뒤 `tick()` 한 번으로 다음을 확인합니다.

1. trigger backfill·claim
2. bounded ReflectionSnapshot 생성
3. 실제 structured runner adapter 호출
4. succeeded Growth RuntimeExecution ID와 suggestion source 저장
5. Reflection commit 직후 강제 중단한 다음 tick에서 evaluation을 이어가며 중복 trigger·reflection·suggestion 없음

- [ ] **Step 2: trigger lease의 실제 회수 메서드만 추가합니다.**

`GrowthTriggerStore`에 만료된 `claimed` row를 CAS로 `pending`에 되돌리는 `requeueExpired(context, now)`를 추가합니다. 이때 이미 고정된 `configuration_version_id`는 지우지 않습니다. 재-claim은 ID가 없을 때만 current configuration을 resolve하고, ID가 있으면 같은 조직·요청자의 저장된 version을 검증해 재사용합니다. 사용자가 crash 사이 설정을 바꿨다고 기존 Reflection snapshot/request hash가 새 configuration으로 바뀌면 안 됩니다. generating Reflection이 있으면 trigger를 새로 만들지 않고 그 row와 고정 snapshot으로 재개합니다. `GrowthRecoveryService.scan()`이 분류만 하는 기존 역할은 유지하고, 새 queue abstraction은 만들지 않습니다.

server worker가 내부 파일 경로를 우회 import하지 않도록 `packages/growth/src/index.ts`에서 값으로 `GrowthTriggerStore`를 export합니다. Task 3의 `GrowthRuntimeAgentIdentityReader`도 같은 root export 원칙을 사용하고, `MetricObservationStore`는 기존 `@massion/assurance` export를 재사용합니다.

- [ ] **Step 3: `GrowthWorker` 한 파일에서 snapshot과 source verifier를 조립합니다.**

`tick(context)`는 다음 순서만 가집니다.

```text
recover expired lease
→ backfill completed Records
→ claim oldest pending trigger
→ WorkRecord·Verification·AssuranceRun·Work event·Message·Artifact·Evidence 출처를 bounded 조회
→ createReflectionSnapshot()
→ GrowthGateway.reflect()
→ recovery scan의 generating Reflection과 proposed/evaluated suggestion 재개
→ 각 suggestion의 signal·evaluation 처리
```

`ReflectionSourceReference.kind`에는 기존 종류에 `verification | assurance`를 추가해 검증 결과를 임의의 `event`로 위장하지 않습니다. SurrealDB의 `growth_source_reference.source_kind`는 이미 string이므로 과거 migration은 수정하지 않습니다.

ReflectionSnapshot의 `activeVersions`는 처리 시점의 current target이 아니라 source Work가 고정한 계보에서 읽습니다. Prompt·Memory는 `work.prompt_version_id → prompt_version.prompt_definition_version_id/memory_version_ids`, Policy는 `work.policy_version_id`, Organization은 `work.organization_version_id`와 각 checksum을 사용합니다. current target `inspect()`는 이후 Task 3의 stale target 신호에서만 사용합니다.

출처는 종류별 최대 20개, 전체 100개로 제한합니다. 본문은 기존 `@massion/evidence`의 `redactSecrets()`를 재사용하고 새 secret 정규식을 만들지 않습니다. source를 kind·ID로 정렬한 뒤 각 redacted excerpt를 UTF-8 4,096 byte, 전체를 24,000 byte에서 결정적으로 자르며 `Math.ceil(totalUtf8Bytes / 4) <= 6_000`을 input token estimate 상한으로 검사합니다. Runtime의 `input_json`에도 같은 bounded redacted projection만 저장됐는지 통합 테스트 한 assertion으로 확인합니다. checksum이 이미 있는 row는 그 값을 쓰고, 없는 row는 이 canonical projection의 SHA-256을 씁니다. verifier는 같은 ID·tenant·Work·captured revision을 다시 읽어 checksum을 재계산합니다. DB row 전체나 credential·provider token·memory value 원문을 prompt에 넣지 않습니다.

- [ ] **Step 4: 현재 routed runtime을 Reflection generator로 사용합니다.**

`GrowthWorker`가 주입받은 `StructuredAgentRunner`의 `executeStructured()`를 다음 고정 identity로 호출합니다.

```ts
{
  commandId: `${trigger.trigger_id}:reflection`,
  workId: trigger.work_id,
  agentHandle: "growth",
  modelRoute: "planning-quality",
  correlationId: trigger.records_run_id,
  estimatedTokens: 8_000,
  estimatedCostMicros: 0,
  input: { reflectionSnapshotHash: snapshot.hash, sources: boundedRedactedSources },
}
```

출력 schema는 `SuggestionCandidate[]` 네 operation만 허용하고 기존 `validateSuggestionCandidate()`가 최종 검증합니다. server의 throw-only generator·verifier를 삭제합니다.

- [ ] **Step 5: 신뢰된 로컬 bootstrap 뒤에만 작은 주기 실행을 연결합니다.**

daemon 시작 시에는 아직 `TenantContext`가 없으므로 worker를 시작하지 않습니다. `LocalApplicationBootstrap`에 optional `onInitialized(context)` hook 하나를 추가하고, tenant 검증·개인 조직 bootstrap이 끝난 뒤 server가 `GrowthWorker.start(context)`를 호출합니다. 같은 조직의 반복 bootstrap은 같은 timer를 재사용하고 다른 조직 context는 개인용 v1에서 실패 폐쇄합니다.

`start()`의 성공 조건은 context 저장과 timer 설치뿐이며 최초 tick을 await해 로컬 앱 bootstrap을 막지 않습니다. 즉시 background tick을 예약하고 이전 tick이 끝나기 전에는 다음 tick을 건너뜁니다. Provider/source 오류는 기존 trigger·Reflection blocked 상태와 redacted 운영 로그로 격리한 뒤 다음 interval을 유지합니다. `close()`만 timer를 해제하고 진행 중인 tick을 기다립니다. daemon의 `drainServices`에는 `growthWorker.close()`를 `routedRunner` shutdown보다 먼저 등록해 종료 뒤 timer나 새 모델 호출이 남지 않게 합니다.

- [ ] **Step 6: 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/growth test -- trigger.test.ts snapshot.test.ts
pnpm --filter @massion/application test -- bootstrap.test.ts product.test.ts
pnpm --filter @massion/server test -- growth-worker.test.ts product.test.ts
pnpm --filter @massion/server typecheck
git add packages/growth/src/trigger.ts packages/growth/src/trigger.test.ts packages/growth/src/snapshot.ts packages/growth/src/snapshot.test.ts packages/growth/src/index.ts packages/application/src/bootstrap.ts packages/application/src/bootstrap.test.ts packages/application/src/product.ts packages/application/src/product.test.ts apps/server/src/growth-worker.ts apps/server/src/growth-worker.test.ts apps/server/src/product.ts apps/server/src/product.test.ts
git commit -m "feat(growth): 완료 업무를 Reflection worker에 연결" \
  -m "Records 완료 trigger를 검증된 출처 snapshot과 실제 structured Growth 실행으로 처리하고 lease replay를 멱등하게 복구합니다."
```

## Task 3: 평가·채택·효과·복원 순환 완성

**Files:**

- Modify: `apps/server/src/growth-worker.ts`
- Modify: `apps/server/src/growth-worker.test.ts`
- Modify: `packages/growth/src/effect.ts`
- Modify: `packages/growth/src/effect.test.ts`
- Modify: `packages/growth/src/evaluation.ts`
- Modify: `packages/growth/src/evaluation.test.ts`
- Modify: `packages/growth/src/governance-adapter.ts`
- Modify: `packages/growth/src/index.ts`
- Modify: `packages/growth/src/revert.ts`
- Modify: `packages/growth/src/revert.test.ts`
- Modify: `packages/growth/src/compliance.ts`
- Modify: `packages/growth/src/compliance.test.ts`
- Modify: `packages/growth/src/recovery.ts`
- Modify: `packages/growth/src/recovery.test.ts`
- Modify: `packages/growth/src/gateway.ts`
- Modify: `apps/server/src/product.ts`
- Modify: `apps/server/src/product.test.ts`

- [ ] **Step 1: 네 target × 두 mode를 한 표로 먼저 고정합니다.**

`apps/server/src/growth-worker.test.ts`의 한 표가 Prompt·Memory·Policy·Organization 각각에 대해 다음을 확인합니다.

- `review`: eligible까지만 자동, target unchanged, `awaiting-review` 한 건
- `auto`: eligible 뒤 개별 승인 없이 apply, 다음 Work가 after version 사용
- stale source/target, 명시적 user memory 동일 key, 독립 신호 없음: 어떤 mode에서도 apply 안 됨
- Reflection 완료 뒤 또는 Adoption 직후 process를 끊어도 다음 tick이 evaluation·baseline·observation을 이어감

- [ ] **Step 2: 기존 receipt store로 여섯 신호를 기록합니다.**

worker는 suggestion마다 기존 `recordSignal()`을 사용합니다.

| signal | group/origin | 정본 |
|---|---|---|
| `lineage` | required/deterministic | Reflection source 재검증 |
| `target` | required/deterministic | target `inspect()` version·checksum |
| `candidate` | required/deterministic | typed patch·security validator |
| `assurance` | supporting/independent | source Work의 terminal Assurance·Verification |
| `self` | supporting/model-self | Growth RuntimeExecution과 suggestion rationale checksum |
| `explicit-memory-conflict` | conflict/deterministic | user MemoryVersion의 같은 key |

독립 Assurance가 없으면 `blocked`, conflict가 passed면 `ineligible`입니다. stale required source는 `fresh: false` receipt로 보존한 뒤 `blocked`로 판정합니다. 현재처럼 `recordSignal()`에서 먼저 throw하지 않도록 `GrowthEvaluationStore`를 바꾸되 fresh required signal의 통과 조건은 낮추지 않습니다. 모델 자기평가 하나만으로 eligible을 만들지 않습니다.

- [ ] **Step 3: 평가 결과에 따라 기존 adoption을 호출합니다.**

worker는 `evaluation.outcome === "eligible"`일 때만 `GrowthGateway.adopt()`를 호출합니다. 저장된 configuration이 `review`면 기존 Governance approval과 `awaiting-review`를 유지하고, `auto`면 기존 target port transaction으로 적용합니다. command ID는 suggestion ID와 evaluation input hash로 결정해 retry가 새 version을 만들지 않게 합니다.

생산 `GovernanceGate`의 다섯 번째 인자에 `GrowthRuntimeAgentIdentityReader(database, organizations)`를 주입합니다. 이 reader를 Growth root index에서 export하고, 실제 succeeded `growth` RuntimeExecution은 authorize되지만 다른 handle·Work·tenant·상태는 거부되는 product test를 둡니다. 테스트에서만 identity reader를 쓰고 생산 Gate를 네 인자로 남기지 않습니다.

- [ ] **Step 4: 효과 표본을 terminal Assurance에서만 조립합니다.**

`GrowthEffectSample`에 다음 lineage를 추가하고 store가 `sample_lineage_json`·checksum으로 함께 저장하게 합니다.

```ts
interface GrowthEffectSampleLineage {
  readonly targetVersionId: string;
  readonly samples: readonly {
    readonly workId: string;
    readonly assuranceRunId: string;
    readonly verificationId: string;
    readonly recordsRunId?: string;
    readonly workRecordId?: string;
    readonly metricObservationId: string;
    readonly sourceChecksum: string;
  }[];
}
```

server는 `MetricObservationStore`에 `massion.growth.assurance-pass-rate.v1` system adapter를 등록합니다. adapter는 `work_verification.evidence_artifact_version_id`를 source artifact로 받고 같은 Work의 terminal Assurance를 대조해 `passed = 1`, `failed = 0`, unit `ratio`만 반환합니다. worker는 결정적 command ID `growth-effect-metric:<adoptionId>:<workId>:<assuranceRunId>`로 observation을 기록합니다.

v1 EffectContract는 제품 코드 상수 한 개로 고정합니다.

```ts
{
  metricSourceId: "massion.growth.assurance-pass-rate.v1",
  metricSourceVersion: "1.0.0",
  unit: "ratio",
  direction: "higher",
  minimumObservations: 3,
  stableTolerance: 0.05,
  degradationThreshold: 0.20,
}
```

`strategyVersionId`는 채택에 사용한 Growth evaluation strategy입니다. `caseSetChecksum`은 canonical `{ profileId, profileVersion, criteriaChecksum, targetKind, metricSourceId }`의 SHA-256이며, 이 값이 같은 Work만 비교합니다. `windowChecksum`은 canonical `{ schemaVersion: "massion.growth.effect-window.v1", selection: "three-terminal-assurances", order: "terminalAt,assuranceRunId", minimumObservations: 3 }`의 SHA-256입니다. baseline은 before version의 최신 3건, observation은 adoption 뒤 after version의 최초 3건을 정렬해 사용합니다. 실제 표본 identity는 별도 `sample_lineage_checksum`으로 고정하고 observe command ID도 `growth-effect-observe:<adoptionId>:<sampleLineageChecksum>`을 사용합니다.

Adoption 직후 worker는 pending baseline을 찾아 `before_version_id`를 실제 사용한 최근 terminal Assurance cohort로 `captureBaseline()`하고, 이후 tick마다 `after_version_id`를 사용한 새 terminal Assurance를 관찰해 contract 표본 수가 찼을 때 `observeEffect()`를 호출합니다. 성공 Work의 finalized WorkRecord·RecordsRun은 ID와 checksum을 검증하고, terminal failed Assurance는 값 0으로 포함하되 존재하지 않는 Records를 만들거나 필수화하지 않습니다. score는 검증된 observation의 평균으로만 계산하며 public command나 Renderer에서 받지 않습니다.

각 sample의 `sourceChecksum`은 Work ID·고정 target version/checksum·AssuranceRun ID/result/checksum·Verification ID/checksum·MetricObservation ID/checksum과 존재하는 RecordsRun·WorkRecord ID/checksum을 key 순서로 canonicalize한 SHA-256입니다. cohort lineage는 sample을 `workId`, `assuranceRunId` 순으로 정렬한 뒤 checksum을 계산합니다.

- [ ] **Step 5: degraded를 같은 tick에서 복원합니다.**

`observeEffect()`가 `improved | stable`이면 adoption을 terminal `retained`로 바꾸고 baseline을 닫으며 `active_target_guard`를 해제해 같은 target의 다음 개선을 허용합니다. `inconclusive`만 `observing`을 유지합니다. `degraded`면 노출 상태를 먼저 `suspended`로 기록하고 즉시 기존 `GrowthRevertService.revert()`를 호출합니다. `auto`는 자동 복원하고 `review`는 복원 승인 대기로 남깁니다. 복원이 끝날 때까지 Task 1의 `GrowthWorkPromptAdapter` guard가 새 Work 생성을 막습니다. 사용자의 명시적 revert는 `retained`도 허용하되 현재 active target이 그 adoption의 after version·checksum일 때만 수행하고, degraded 자동 복원은 계속 `observing`만 허용합니다.

`GrowthRecoveryService.scan()`은 generating Reflection뿐 아니라 proposed/evaluated suggestion, pending baseline, observing adoption과 진행 중 revert를 찾고, worker는 분류 결과를 기록만 하지 말고 기존 domain command ID로 실제 action을 재실행합니다. recovery 기록 command ID는 `growth-recovery:<stage>:<aggregateId>:<stateChecksum>`으로 만들어 상태가 같으면 replay하고 상태가 바뀌면 새 판단을 기록합니다. 변하는 state를 hash에 넣으면서 고정 command ID를 재사용해 두 번째 scan이 request hash mismatch로 멈추게 두지 않습니다.

- [ ] **Step 6: 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/growth test -- evaluation.test.ts effect.test.ts revert.test.ts recovery.test.ts compliance.test.ts
pnpm --filter @massion/server test -- growth-worker.test.ts
pnpm --filter @massion/growth typecheck
pnpm --filter @massion/server typecheck
git add apps/server/src/growth-worker.ts apps/server/src/growth-worker.test.ts apps/server/src/product.ts apps/server/src/product.test.ts packages/growth/src/evaluation.ts packages/growth/src/evaluation.test.ts packages/growth/src/governance-adapter.ts packages/growth/src/index.ts packages/growth/src/effect.ts packages/growth/src/effect.test.ts packages/growth/src/revert.ts packages/growth/src/revert.test.ts packages/growth/src/compliance.ts packages/growth/src/compliance.test.ts packages/growth/src/recovery.ts packages/growth/src/recovery.test.ts packages/growth/src/gateway.ts
git commit -m "feat(growth): 평가부터 효과 복원까지 생산 순환 완성" \
  -m "독립 Assurance 신호와 검증된 업무 표본으로 review·auto 채택을 결정하고 저하된 target을 노출 중단 뒤 복원합니다."
```

## Task 4: Growth 제품 계약과 사용자 결정 공개

**Files:**

- Modify: `packages/growth/src/reflection.ts`
- Modify: `packages/growth/src/configuration.ts`
- Modify: `packages/growth/src/adoption.ts`
- Modify: `packages/growth/src/adoption.test.ts`
- Modify: `packages/growth/src/effect.ts`
- Modify: `packages/growth/src/revert.ts`
- Modify: `packages/growth/src/gateway.ts`
- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/adapters/domain.ts`
- Modify: `packages/application/src/adapters/domain.test.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `packages/application/src/query-registry.test.ts`

- [ ] **Step 1: 공개 계약을 정확한 이름으로 타입화합니다.**

Queries:

- `growth.configuration.get`
- `growth.memories` — 지식·기억 계획이 만든 explicit user view 재사용
- `growth.suggestions`
- `growth.suggestion.get`
- `growth.evaluation.get`
- `growth.evaluation.signals`
- `growth.adoption.get`
- `growth.effects`

Commands:

- `growth.configure`
- `growth.memory.put`, `growth.memory.forget` — 기존 지식·기억 계약 재사용
- `growth.suggestion.evaluate`
- `growth.suggestion.approve`
- `growth.suggestion.reject`
- `growth.adoption.revert`

설계의 위 이름을 제품 정본으로 사용합니다. 이미 등록된 `growth.adopt`, `growth.revert`는 기존 호출자 호환 adapter로 유지하되 Desktop의 새 정본 호출에는 사용하지 않습니다.

- [ ] **Step 2: 상세 projection이 계보를 버리지 않게 합니다.**

Suggestion detail에는 source reference·revision·patch diff·evaluation receipts·before/after version·effect contract/evaluation과 awaiting review의 `approvalId`·원래 Adoption domain command ID를 포함합니다. 내부 DB ID를 제목으로 쓰지 않고 path·Work 제목·target 이름을 함께 투영합니다. credential, prompt 원문 전체, memory value 원문은 source projection에서 제외합니다.

- [ ] **Step 3: 명시적 reject를 CAS로 저장합니다.**

`GrowthGateway.reject()`는 `suggestionId`, `expectedRevision`, 1~1,000자 reason만 받습니다. `proposed | evaluated | awaiting-review`에서 `rejected`로 한 번 전이하고 reason·user·time과 immutable event를 남깁니다. awaiting adoption은 같은 CAS에서 `rejected`, `active_target_guard = NONE`으로 바꾸고 `approvalId`를 반환합니다. Application handler는 결정적 cancel command로 그 approval을 취소합니다. 중간 crash 뒤 replay는 같은 rejected row와 approval ID를 읽어 남은 cancel만 끝냅니다. adopted·rejected·superseded는 거부합니다.

`growth.suggestion.approve` handler는 상세에 저장된 evaluation precondition을 다시 읽고 기존 approval을 승인한 뒤, worker가 처음 사용한 같은 Adoption domain command ID와 returned `approvalId`로 `GrowthGateway.adopt()`를 replay합니다. approval만 결정하고 Adoption replay를 빼먹어 `awaiting-review`에 남는 경로를 허용하지 않습니다.

- [ ] **Step 4: Growth event가 필요한 query만 무효화하게 합니다.**

기존 `ApplicationEventProjector`의 `growth-event` mapping과 Desktop의 durable `eventRevision`을 재사용합니다. configuration·suggestion·adoption·effect·revert의 각 상태 전이는 자기 상태 row와 같은 transaction에서 generic `growth_event`도 기록합니다. Reflection 완료 한 종류만 기록하는 현재 공백을 닫되 새 outbox source나 event projector 분기는 만들지 않습니다. Desktop은 개선 query와 전역 Inbox 원천만 다시 읽고 전체 App snapshot을 매번 reload하지 않습니다.

- [ ] **Step 5: 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/growth test
pnpm --filter @massion/application test -- adapters/domain.test.ts query-registry.test.ts
pnpm --filter @massion/application typecheck
git add packages/growth/src/reflection.ts packages/growth/src/configuration.ts packages/growth/src/adoption.ts packages/growth/src/adoption.test.ts packages/growth/src/effect.ts packages/growth/src/revert.ts packages/growth/src/gateway.ts packages/application/src/contracts.ts packages/application/src/adapters/domain.ts packages/application/src/adapters/domain.test.ts packages/application/src/query-registry.ts packages/application/src/query-registry.test.ts
git commit -m "feat(application): Growth 결정과 효과 계보 공개" \
  -m "개선 설정·상세·승인·거절·되돌리기를 typed 계약으로 제공하고 수신함과 개선 화면이 같은 상태를 읽게 했습니다."
```

## Task 5: 개선 화면·설정·수신함을 실데이터에 연결

**Files:**

- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/desktop-service.test.ts`
- Modify: `apps/desktop/src/app.tsx`
- Modify only if a structural failure is found: `apps/desktop/src/app.integration.test.tsx`

- [ ] **Step 1: fixture·disabled 행동을 typed service로 교체합니다.**

기존 완성본 레이아웃은 유지하고 `loadGrowthSuggestions`, `loadGrowthSuggestion`, `configureGrowth`, `evaluateGrowthSuggestion`, `approveGrowthSuggestion`, `rejectGrowthSuggestion`, `revertGrowthAdoption`을 typed Application client에 연결합니다. 새 `unknown` parser나 desktop cache는 만들지 않습니다.

- [ ] **Step 2: 결정은 개선 상세에서만 수행합니다.**

수신함과 홈의 `awaiting-review` 항목은 `업무/후보 제목 ›`로 개선 상세에 이동만 합니다. suggestion detail의 `approvalId`와 같은 일반 Governance approval은 Inbox projection에서 제거해 후보 하나가 두 번 보이지 않게 합니다. 승인·거절 버튼은 상세의 source·독립 신호·반대 신호·diff·expected effect를 읽은 뒤에만 보이며, 승인 성공은 같은 Adoption command replay까지 끝난 뒤에만 표시합니다.

- [ ] **Step 3: 설정에 두 Growth 선택을 연결합니다.**

- `업무가 끝나면 개선 후보 찾기`: `reflectionEnabled`
- `검토 후 반영 | 검증되면 자동 반영`: `adoptionMode`

기본값은 `true + review`이며 auto 선택 전 영향 설명을 한 번 보여줍니다. stale revision은 재조회 후 사용자가 다시 선택하게 하고 자동 overwrite하지 않습니다.

- [ ] **Step 4: 실제 화면을 먼저 조작합니다.**

기존 desktop 테스트를 실행한 뒤 dev Tauri에서 review 승인·거절과 auto 설정을 조작합니다. 구조적 실패가 확인된 경우에만 통합 테스트 한 건을 추가합니다.

- [ ] **Step 5: 검증하고 커밋합니다.**

```sh
pnpm exec eslint apps/desktop/src
pnpm --filter @massion/desktop typecheck
pnpm --filter @massion/desktop test
git add apps/desktop/src/desktop-service.ts apps/desktop/src/desktop-service.test.ts apps/desktop/src/app.tsx
# 실제 구조적 회귀를 추가한 경우에만 app.integration.test.tsx도 stage합니다.
git commit -m "feat(desktop): 지속 발전 순환을 개선 화면에 연결" \
  -m "수신함은 탐색만 제공하고 개선 상세에서 근거를 본 뒤 review 결정하거나 사용자 선택 auto를 설정하게 했습니다."
```

## Task 6: 실제 UAT-G01~G02와 추적 근거 확정

**Files:**

- Create: `docs/evidence/phase-30/growth-production-uat-2026-07-25.md`
- Modify: `docs/generated/requirements-traceability.tsv`
- Modify: `PRODUCT.md`
- Modify: `docs/product/constitution.md`

- [ ] **Step 1: 같은 후보 SHA에서 표적 gate를 실행합니다.**

```sh
pnpm --filter @massion/growth test
pnpm --filter @massion/application test
pnpm --filter @massion/server test
pnpm --filter @massion/desktop test
pnpm --filter @massion/desktop typecheck
```

Expected: 모두 exit 0, 의도하지 않은 skip 증가 없음.

- [ ] **Step 2: 실제 Tauri 앱에서 UAT-G01과 UAT-G02를 실행합니다.**

개인 BYOK Provider의 실제 완료 Work를 사용합니다. Computer Use로 review 후보 생성·상세 출처·승인, auto 채택, 다음 Work version, degraded 표본, suspended 차단, 복원, review 복귀를 순서대로 검증합니다.

- [ ] **Step 3: read-only 계보를 대조합니다.**

동일 후보의 WorkRecord → ReflectionSnapshot hash → Growth RuntimeExecution → source receipts → Evaluation → Adoption before/after → 후속 Work Prompt/Memory/Policy/Organization version → Effect sample → Revert가 모두 연결돼야 합니다. Effect의 failed Assurance 표본에는 Work·Verification·Assurance·MetricObservation을 요구하고 Records는 존재할 때만 대조합니다. 원문과 비밀은 evidence에 복사하지 않고 ID·checksum·redacted summary만 기록합니다.

- [ ] **Step 4: 네 target 동등성을 자동 표와 대조합니다.**

UAT는 대표 target 하나를 실제 조작하고, Prompt·Memory·Policy·Organization 네 target의 `review | auto | stale | degraded` 동등성은 Task 3의 표 기반 server 테스트 결과와 같은 후보 SHA로 기록합니다.

- [ ] **Step 5: 추적표와 제품 문서를 실제 값으로 갱신하고 커밋합니다.**

`REQ-GROWTH-001`, `REQ-GROWTH-002`, `REQ-GROWTH-UAT-001`의 tests·commits·events·metrics·evidence를 실제 값으로 바꾸고 모든 조건을 충족한 행만 `completed`로 표시합니다.

```sh
git add docs/evidence/phase-30/growth-production-uat-2026-07-25.md docs/generated/requirements-traceability.tsv PRODUCT.md docs/product/constitution.md
git commit -m "docs(phase-30): 지속 발전 실사용 근거 기록" \
  -m "실제 완료 업무에서 review·auto 채택과 검증된 효과 저하 복원을 같은 후보 SHA로 확인했습니다."
```

## 4. 완료 게이트

- [ ] completed RecordsRun 하나가 trigger·ReflectionRun 하나로 멱등 처리됩니다.
- [ ] Reflection은 실제 succeeded Growth RuntimeExecution과 검증된 source checksum을 가집니다.
- [ ] required 세 신호와 independent 신호가 없으면 어떤 target도 채택되지 않습니다.
- [ ] 기본 `review`는 승인 전 target을 바꾸지 않고, 사용자 선택 `auto`만 적격 후보를 자동 채택합니다.
- [ ] Prompt·Memory·Policy·Organization 네 target이 같은 revision·checksum·평가 계약을 사용합니다.
- [ ] 새 Work만 after version을 사용하며 과거 Work 계보는 바뀌지 않습니다.
- [ ] 효과 표본은 Work·Assurance·Verification·MetricObservation checksum을 모두 가지며 성공 Work의 Records는 함께 검증되고 실패 Assurance에는 강제되지 않습니다.
- [ ] degraded target은 새 Work에 노출되지 않고 자동 또는 승인된 이전 version으로 복원됩니다.
- [ ] improved·stable adoption은 terminal retained로 닫혀 같은 target의 다음 개선을 막지 않습니다.
- [ ] retained adoption도 현재 active target과 checksum이 일치하면 사용자가 명시적으로 되돌릴 수 있습니다.
- [ ] 수신함은 탐색만 제공하고 모든 결정은 개선 상세에서 이루어집니다.
- [ ] UAT-G01~G02가 실제 빌드 후보에서 통과합니다.
