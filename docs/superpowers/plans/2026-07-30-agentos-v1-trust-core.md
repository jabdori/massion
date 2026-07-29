# AgentOS v1 Trust Core Implementation Plan

> **실행 방식:** 독립 축은 최대 네 개만 병렬 실행한다. 각 축은 구현자 1명과 검수자 1명으로 제한하며 재귀 위임하지 않는다.

**Goal:** 재시작·동시성·Provider 실패·평가 오류에서도 Work와 계보가 정확히 한 번 수렴하고, 작은 보안·공급망 gate가 녹색인 v1 신뢰 코어를 만든다.

**Architecture:** 기존 Work·Records·Strategy·Router·Growth의 정본과 결정적 command ID를 유지하면서 상태별 continuation과 단일 실행 소유권을 추가한다. 외부 부작용은 증명 가능한 무부작용 실패에서만 fallback하고, 검증·평가 영수증은 실제 실행 모델과 일치할 때만 만든다.

**Tech Stack:** TypeScript, Vitest, SurrealDB transaction layer, Node.js 24, Rust/Tauri, pnpm 11.

**작업 규칙:** 현재 dirty 작업 트리의 사용자 변경을 보존한다. 각 원자 작업은 명세 검수와 코드 품질 검수를 모두 통과한 뒤 해당 파일만 선택해 한국어 상세 커밋으로 남긴다. 각 coder는 자기 파일만 수정하고 reviewer는 수정하지 않는다.

**검증 규칙:** 변경 중에는 실패를 재현하는 표적 테스트만 실행한다. 전체 build·security·hardening은 묶음 경계와 최종 후보에서 실행한다. 시각 검수는 UI 묶음에 집중하며 백엔드 원자 변경마다 반복하지 않는다.

---

## 파일 책임 지도

- `packages/application/src/core-records-stage.ts`: Records 상태별 continuation.
- `packages/records/src/service.ts`, `packages/records/src/run-store.ts`: Records 조회·terminal 전이.
- `packages/work/src/records-port.ts`: Work·Records 완료 원자 transaction.
- `packages/context-strategy/src/strategy-service.ts`: Context snapshot 재사용.
- `packages/context-strategy/src/strategy-generator.ts`: generation 소유권과 pending 재개.
- `apps/server/src/application-run-startup-recovery.ts`, `packages/application/src/run-store.ts`: 전체 페이지 startup recovery.
- `packages/application/src/core-delivery-stage.ts`, `packages/application/src/core-work-coordinator.ts`: terminal 실패 의미.
- `apps/server/src/growth-worker.ts`, `packages/growth/src/recovery.ts`: orphan suggestion 재개.
- `packages/subscriptions/src/policy-store.ts`, `packages/router/src/model-router.ts`: 실행 표면 공통 정책과 trust origin.
- `packages/runtime/src/subscriptions/codex-connector.ts`, `apps/server/src/codex-app-server-agent.ts`: Codex pre-effect 인증 실패 정규화.
- `apps/server/src/product.ts`, `packages/router/src/model-router.ts`: 평가 후보 집합과 실제 모델 검증.
- `scripts/verify-security.mjs`, `apps/web/package.json`, `apps/desktop/src-tauri/src/lib.rs`, `.github/workflows/desktop-release.yml`: 공급망·Rust gate.

### Task 1: 작은 검증 gate를 먼저 복구한다

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/verify-security.mjs`
- Modify: `scripts/verify-security.test.mjs`
- Modify: `scripts/release-workflow.test.mjs`
- Modify: `.github/workflows/desktop-release.yml`

완료 커밋: `12b595cc8` (`fix(security): 데스크톱 출시 검증 게이트 강화`)

- [x] **Step 1: Rust capability 실패 기대값을 실제 최소 권한과 맞춘다.**

```rust
json!([
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "dialog:allow-open",
    "allow-bootstrap",
    "allow-query",
    "allow-command",
    "allow-stream-start",
    "allow-stream-stop"
])
```

- [x] **Step 2: PostCSS를 현재 레지스트리 최신 보안 패치로 올린다.**

2026-07-30 npm registry 확인값은 `8.5.25`다.

Run: `pnpm --filter @massion/web update postcss@8.5.25 --save-dev --save-exact`

- [x] **Step 3: 보안 검증에 full dependency audit를 추가한다.**

`verify-security.mjs`에서 production audit과 full audit를 각각 실행하고 둘 다 moderate/high/critical 0을 요구한다. `assertAuditReport()`는 기존 함수를 재사용한다.

- [x] **Step 4: release workflow의 signing build 전에 gate를 추가한다.**

```yaml
- name: 서명 전 보안 검증
  run: pnpm verify:security

- name: Tauri Rust 검증
  run: cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

- [x] **Step 5: 검증한다.**

Run: `node --test scripts/verify-security.test.mjs`

Run: `pnpm verify:security`

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`

Expected: 모두 exit 0, JS full/prod audit moderate/high/critical 0, Rust 11 tests pass.

### Task 2: Records 상태별 continuation을 구현한다

**Files:**
- Modify: `packages/records/src/service.ts`
- Modify: `packages/records/src/run-store.ts`
- Modify: `packages/records/src/run-store.test.ts`
- Modify: `packages/application/src/core-records-stage.ts`
- Modify: `packages/application/src/core-records-stage.test.ts`

- [ ] **Step 1: rendering/finalized 재시작 실패 테스트를 추가한다.**

같은 stage start command로 저장된 run을 먼저 조회해 `rendering` 또는 `finalized`를 반환하게 하고, 변경된 현재 Work snapshot으로 `start()`를 다시 호출하지 않는지 검증한다. finalized 상태에서는 Work revision과 snapshot이 이미 달라졌으므로 기존 `start()` replay를 먼저 호출하면 payload hash 충돌이 발생한다.

```ts
expect(calls).toEqual(["find-by-command", "assessments", "documents", "finalize", "complete"]); // rendering
expect(calls).toEqual(["find-by-command", "complete"]); // finalized
```

- [ ] **Step 2: RecordsService에 결정적 command 조회와 기존 assessment 조회를 노출한다.**

```ts
public async findByCommandId(context: TenantContext, commandId: string) {
  return await this.runs.findByCommandId(context, commandId);
}

public async assessments(context: TenantContext, recordsRunId: string) {
  return await this.runs.listAssessments(context, recordsRunId);
}
```

Gateway와 `RecordsRunStore`에 tenant 검증이 있는 조회를 추가한다. command 조회는 없는 경우 `undefined`를 반환하고, 같은 조직의 정확한 command row만 읽는다. assessment 조회는 기존 private transaction helper를 감싼다.

- [ ] **Step 3: stage를 저장 상태로 분기한다.**

```ts
const existing = await records.findByCommandId(context, `${input.commandId}:start`);
const run = existing ?? await records.start(context, stableStartInput);
if (run.status === "completed") return advanced(run);
if (run.status === "finalized") return await completeExisting(run);
const assessments = run.status === "planned"
  ? (await records.proposeImpacts(...)).assessments
  : await records.assessments(context, run.recordsRunId);
// rendering만 documents/finalize를 실행한 뒤 complete
```

blocked/cancelled는 명시적 blocked result로 반환한다. 반환 계보의 snapshot hash는 재시작 때 다시 계산한 값이 아니라 저장된 `run.snapshotHash`를 사용한다.

- [ ] **Step 4: 표적 검증을 실행한다.**

Run: `pnpm exec vitest run packages/application/src/core-records-stage.test.ts packages/records/src/service.test.ts packages/records/src/run-store.test.ts --maxWorkers=1`

Expected: rendering/finalized 재시작 포함 전부 pass.

### Task 3: Work와 Records 완료를 원자적으로 확정한다

**Files:**
- Modify: `packages/work/src/records-port.ts`
- Modify: `packages/records/src/service.ts`
- Modify: `packages/work/src/records.test.ts`
- Modify: `packages/records/src/service.test.ts`

- [ ] **Step 1: terminal 기록 오류 주입 테스트를 작성한다.**

Records terminal write가 실패하도록 DB wrapper를 구성하고 Work만 `completed`로 남지 않음을 기대한다.

```ts
await expect(service.complete(context, { recordsRunId })).rejects.toThrow();
expect((await work.recoverWork(context, workId)).work.status).toBe("verifying");
expect((await records.get(context, recordsRunId)).status).toBe("finalized");
```

- [ ] **Step 2: WorkRecordsPort.complete 입력에 Records terminal 조건을 포함한다.**

```ts
interface CompleteRecordsProjectionInput {
  readonly recordsRunId: string;
  readonly expectedRecordsVersion: number;
  // 기존 Work completion fields
}
```

- [ ] **Step 3: 한 database transaction에서 Work와 records_run을 함께 갱신한다.**

기존 Work completion validation/event 작성 뒤 같은 transaction에서 `records_run.status='completed'`, version 증가, terminal event를 확정한다. `RecordsService.complete()`의 별도 `runs.complete()` 호출은 제거하고 transaction 결과의 run을 반환한다.

- [ ] **Step 4: replay·동시 complete·Growth 사건을 검증한다.**

Run: `pnpm exec vitest run packages/work/src/records.test.ts packages/records/src/service.test.ts packages/records/src/recovery.test.ts --maxWorkers=1`

Expected: 원자 실패 테스트와 기존 command replay 모두 pass.

### Task 4: Strategy retry·동시 소유권·pending 재개를 닫는다

**Files:**
- Modify: `packages/context-strategy/src/strategy-service.ts`
- Modify: `packages/context-strategy/src/strategy-generator.ts`
- Modify: `packages/context-strategy/src/recovery.ts`
- Modify: `packages/context-strategy/src/strategy-service.test.ts`
- Modify: `packages/context-strategy/src/strategy-generator.test.ts`
- Modify: `packages/context-strategy/src/recovery.test.ts`

- [ ] **Step 1: 세 실패 테스트를 먼저 추가한다.**

```ts
it("실패 전 ContextVersion을 새 retry가 재사용한다", ...);
it("동일 command 동시 호출은 runner를 한 번만 실행한다", ...);
it("pending generation은 새 service에서 terminal 상태로 수렴한다", ...);
```

동시 테스트는 runner barrier와 `Promise.all`을 사용하고 `runnerCalls === 1`을 검증한다.

- [ ] **Step 2: context snapshot ID를 generation retry와 분리한다.**

동일 source checksum의 최신 ContextVersion을 조회해 재사용하고, source가 바뀐 경우에만 최신 ID를 `expectedParentContextVersionId`로 전달해 새 버전을 만든다. ContextStore의 부모 검사는 유지한다.

- [ ] **Step 3: generation transaction이 소유권을 반환하게 한다.**

```ts
type GenerationClaim =
  | { readonly kind: "created"; readonly generation: StrategyGeneration }
  | { readonly kind: "existing"; readonly generation: StrategyGeneration };
```

`created` 호출만 runner를 실행한다. 경쟁 패배자는 command row를 다시 읽어 동일 generation을 반환한다.

- [ ] **Step 4: pending을 terminal replay와 분리한다.**

pending row는 같은 결정적 runtime command를 조회해 완료 결과를 projection하거나, 실행 흔적이 없을 때 generation claim을 다시 획득해 runner를 한 번만 실행한다. 두 복구자가 동시에 들어와도 한 소유자만 외부 실행을 한다.

- [ ] **Step 5: 검증한다.**

Run: `pnpm exec vitest run packages/context-strategy/src/strategy-generator.test.ts packages/context-strategy/src/strategy-service.test.ts packages/context-strategy/src/recovery.test.ts --maxWorkers=1`

Expected: retry applied, concurrent runner 1회, pending 없음.

### Task 5: startup recovery와 Delivery terminal 실패를 수렴시킨다

**Files:**
- Modify: `packages/application/src/run-store.ts`
- Modify: `apps/server/src/application-run-startup-recovery.ts`
- Modify: `apps/server/src/application-run-startup-recovery.test.ts`
- Modify: `packages/application/src/core-delivery-stage.ts`
- Modify: `packages/application/src/core-delivery-stage.test.ts`
- Modify: `packages/application/src/core-work-coordinator.ts`

- [ ] **Step 1: 101개 startup candidate 테스트를 추가한다.**

101개 ready run을 넣고 recovery call 101회, remaining 0, ready true를 기대한다.

- [ ] **Step 2: `(createdAt, runId)` cursor page를 소진한다.**

`listRecoveryCandidates()`에 cursor를 추가하고 서비스가 빈 page를 받을 때까지 순회한다. close가 시작되면 다음 page를 열지 않는다.

- [ ] **Step 3: Delivery 실패 상태 테스트를 추가한다.**

일반 runtime failed는 Task·Work·ApplicationRun이 `failed`, 모델 부재는 기존처럼 `blocked`, 취소는 `cancelled`를 기대한다.

- [ ] **Step 4: 복구 불가능 실패 전이를 공통 경로에 연결한다.**

Delivery stage가 `failed` outcome을 반환하고 coordinator가 Task/Work 실패 projection을 완료한 뒤 ApplicationRun을 failed로 terminal 처리한다. `blocked_model_unavailable` 분기는 변경하지 않는다.

- [ ] **Step 5: 검증한다.**

Run: `pnpm exec vitest run apps/server/src/application-run-startup-recovery.test.ts packages/application/src/core-delivery-stage.test.ts packages/application/src/core-work-coordinator.test.ts --maxWorkers=1`

### Task 6: Growth orphan을 다음 tick에서 재개한다

**Files:**
- Modify: `packages/growth/src/recovery.ts`
- Modify: `apps/server/src/growth-worker.ts`
- Modify: `apps/server/src/growth-worker.test.ts`

- [ ] **Step 1: Reflection 완료 직후 실패 테스트를 추가한다.**

첫 tick에서 evaluation 오류를 주입하고 두 번째 tick에서 같은 suggestion이 정확히 한 번 평가·채택되는지 검증한다.

- [ ] **Step 2: orphan 후보 조회를 추가한다.**

`proposed`와 재개 가능한 `evaluated` suggestion을 결정적 순서로 조회하고 source Reflection/trigger 상태를 함께 검증한다.

- [ ] **Step 3: 새 trigger보다 orphan을 먼저 처리한다.**

worker tick 순서를 `effect → orphan suggestion → pending trigger`로 만들고 기존 evaluation/adoption command ID를 재사용한다.

- [ ] **Step 4: 검증한다.**

Run: `pnpm exec vitest run apps/server/src/growth-worker.test.ts packages/growth/src/recovery.test.ts --maxWorkers=1`

Expected: crash 재시도 정확히 한 번, review/ineligible/effect 기존 테스트 pass.

### Task 7: Provider 기본 정책과 connector trust origin을 고친다

**Files:**
- Modify: `packages/subscriptions/src/policy-store.ts`
- Modify: `packages/subscriptions/src/policy-store.test.ts`
- Modify: `packages/router/src/model-router.ts`
- Modify: `packages/router/src/model-router.test.ts`

- [ ] **Step 1: Edge-only Codex 기본값 실패 테스트를 추가한다.**

미설정 `openai-codex`가 Edge에서 지원하지 않는 `review`를 기본으로 반환하지 않아야 한다. 명시적 server review는 계속 허용한다.

- [ ] **Step 2: 기본 모드를 표면 capability 교집합에서 선택한다.**

configurable union은 UI 선택지에만 사용하고 default는 모든 활성 표면에 공통인 mode 중 `automatic`, `deny` 순으로 선택한다. 공통값이 없으면 fail-closed `deny`다.

- [ ] **Step 3: Router가 location과 trust_origin을 함께 검사한다.**

server/server-managed, edge/edge-device 쌍만 후보로 허용하고 불일치는 excluded reason에 남긴다.

- [ ] **Step 4: 검증한다.**

Run: `pnpm exec vitest run packages/subscriptions/src/policy-store.test.ts packages/router/src/model-router.test.ts --maxWorkers=1`

### Task 8: Codex pre-effect 401만 안전하게 fallback한다

**Files:**
- Modify: `packages/runtime/src/subscriptions/codex-connector.ts`
- Modify: `packages/runtime/src/subscriptions/codex-connector.test.ts`
- Modify: `apps/server/src/codex-app-server-agent.ts`
- Modify: `apps/server/src/codex-app-server-agent.test.ts`
- Modify: `packages/runtime/src/voltagent-runner.test.ts`

- [ ] **Step 1: SDK와 app-server의 명시적 preflight 401 테스트를 추가한다.**

```ts
expect(result).toMatchObject({
  outcome: "failed",
  signal: { kind: "http", statusCode: 401 },
  emittedTokens: 0,
  sideEffectsStarted: false,
});
```

- [ ] **Step 2: adapter 경계에서만 안전 실패로 정규화한다.**

HTTP status 401이고 output/tool event가 하나도 없다는 정보가 있는 경우에만 위 결과를 반환한다. 다른 예외는 throw하거나 `sideEffectsStarted:true`를 유지한다.

- [ ] **Step 3: 실제 Runner fallback 회귀를 추가한다.**

첫 Codex account 401 후 두 번째 account가 성공하고 attempt/session lease 계보가 연결되는지 검증한다. 도구 실행 후 401은 fallback되지 않아야 한다.

- [ ] **Step 4: 검증한다.**

Run: `pnpm exec vitest run packages/runtime/src/subscriptions/codex-connector.test.ts apps/server/src/codex-app-server-agent.test.ts packages/runtime/src/voltagent-runner.test.ts apps/server/src/edge-runtime-fallback.integration.test.ts --maxWorkers=1`

### Task 9: 모델 평가가 실제 대상 모델만 사용하게 한다

**Files:**
- Modify: `apps/server/src/product.ts`
- Modify: `apps/server/src/model-optimization-executor.ts`
- Modify: `apps/server/src/model-optimization-executor.test.ts`
- Modify: `apps/server/src/model-optimization-product.test.ts`

- [ ] **Step 1: 대상 disabled + 다른 모델 enabled 실패 테스트를 작성한다.**

평가가 다른 모델로 실행되지 않고 blocked/no receipt가 되어야 한다. 같은 모델의 다른 credential fallback은 허용한다.

- [ ] **Step 2: 평가 실행기 경계에서 실제 lease의 모델을 검증한다.**

일반 Work의 `preferredModelProfileIds`는 선호 순서라는 기존 의미를 유지한다. 평가 경로만 기대한 모델 프로필 ID를 실행기에 전달하고, 외부 실행 전에 `lease.modelProfileId`와 정확히 일치하는지 검사한다. 새 Router 필드나 새 lease abstraction은 만들지 않는다.

- [ ] **Step 3: 불일치 lease를 기존 무부작용 실패 정산으로 닫는다.**

```ts
if (lease.modelProfileId !== input.modelProfileId) {
  throw new Error("평가 대상과 실제 모델이 다릅니다");
}
```

검사는 모델 호출 전에 실행한다. 기존 `executeOptimizationCase()`의 catch 경로가 `sideEffectsStarted: false`, token 0으로 `lease.fail()`을 호출하므로 이를 재사용한다.

- [ ] **Step 4: 검증한다.**

Run: `pnpm exec vitest run apps/server/src/model-optimization-executor.test.ts apps/server/src/model-optimization-product.test.ts --maxWorkers=1`

Expected: 다른 모델 receipt 0, 동일 모델 credential fallback pass.

### Task 10: Trust Core 전체 회귀를 실행한다

**Files:**
- Modify: `docs/evidence/phase-30/agentos-v1-trust-core-2026-07-30.md`

- [ ] **Step 1: 변경 파일 format과 diff를 확인한다.**

Run: `pnpm exec prettier --check <changed-files>`

Run: `git diff --check`

- [ ] **Step 2: 패키지 표적 테스트를 모두 실행한다.**

Run: `pnpm exec vitest run packages/application/src/core-records-stage.test.ts packages/records/src/service.test.ts packages/work/src/records.test.ts packages/context-strategy/src/strategy-generator.test.ts packages/context-strategy/src/strategy-service.test.ts apps/server/src/application-run-startup-recovery.test.ts packages/application/src/core-delivery-stage.test.ts apps/server/src/growth-worker.test.ts packages/subscriptions/src/policy-store.test.ts packages/runtime/src/subscriptions/codex-connector.test.ts apps/server/src/edge-runtime-fallback.integration.test.ts apps/server/src/model-optimization-executor.test.ts apps/server/src/model-optimization-product.test.ts --maxWorkers=1`

- [ ] **Step 3: 넓은 정적 gate를 실행한다.**

Run: `pnpm build`

Run: `pnpm lint`

Run: `pnpm typecheck`

Run: `pnpm verify:security`

Run: `pnpm verify:hardening`

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`

- [ ] **Step 4: 증거 문서에 후보 SHA, 명령, exit code, pass/skip/fail 수와 미해결 위험만 기록한다.**

Expected: trust-core 관련 FAIL 0. 실제 Tauri/Codex 과금 시나리오는 다음 계획의 별도 evidence로 남긴다.
