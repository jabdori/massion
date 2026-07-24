# 개인용 v1 지식·기억 계층 Integration Plan

> **For agentic workers:** 이 계획을 실행할 때 `executing-plans`를 사용합니다. 독립 작업을 병렬화할 때만 `subagent-driven-development`를 추가합니다.

**Goal:** 신뢰된 Workspace의 파일·코드 그래프와 사용자가 저장한 개인 기억을 실제 Work의 Representative·Strategy·Delivery 입력, 실행 계보, 협업방과 데스크톱 출처에 연결합니다.

**Architecture:** 기존 Evidence Scanner·Tree-sitter Indexer·BM25·CodeGraphService·EvidenceBrief와 Growth PromptMemory·PromptVersion을 재사용합니다. 검색 상위 symbol은 기존 relation을 1-hop만 확장합니다. Evidence 원문은 ContextVersion에 복제하지 않고 실행 직전에 Brief와 checksum을 검증해 materialize합니다. Work·Room·Message·Artifact 관계는 기존 Work ID, ContextVersion, SharedContextReference로 투영합니다.

**Tech Stack:** TypeScript 5.9, Vitest, SurrealDB 3.2.1, Tree-sitter WASM, BM25, React 19, Tauri 2

---

## 1. 실행 위치와 범위

이 계획은 Phase 30 주 계획의 Task 2·3이 `workspaceId`, `workspacePaths`, native picker를 연결한 직후 실행합니다. Phase 30 Task 4의 Core UAT는 이 계획의 Task 1~6이 통과하기 전 시작하지 않습니다.

v1에 포함하는 최소 세로 흐름은 다음과 같습니다.

1. Workspace → Evidence Repository → immutable Revision·IndexVersion
2. 첨부 파일 seed + exact·BM25 검색 + 기존 relation 1-hop 확장
3. EvidenceBrief → metadata-only ContextVersion → 실행 직전 prompt materialization
4. Core Office SharedContextReference와 `work.knowledge` 출처 투영
5. 개인 explicit MemoryVersion → Work PromptVersion → RuntimeExecution lineage
6. 실제 Tauri 앱의 출처·기억 UI와 UAT-K01~K04

전체 LSP, embedding provider, SurrealDB `TYPE RELATION` 전환, 전역 graph explorer는 먼저 만들지 않습니다. Task 7의 실패 게이트가 실제로 열릴 때만 별도 계획을 작성합니다.

각 커밋 전 `git status --short`와 대상 파일의 `git diff --`를 확인하고 현재 Task가 만든 파일·hunk만 stage합니다. 이미 dirty인 공용 파일과 겹치면 먼저 소유권을 분리하며 디렉터리 전체를 stage하지 않습니다.

## 2. 테스트 원칙

구현 전에 고정할 자동 검사는 다음 네 경계뿐입니다.

1. Workspace↔Repository unique guard와 tenant 격리
2. `workspacePaths` 밖 검색·graph 결과 거부
3. EvidenceBrief↔Context source↔materialized prompt의 checksum·Work 소유권
4. 개인 기억 최초 생성·stale revision·사용 중지·새 Work 적용

그 밖의 컴포넌트 문구, 조립 세부, 정상 경로마다 테스트를 만들지 않습니다. 기존 테스트와 실제 앱 시나리오를 먼저 실행하고, 실패하면 가장 낮은 공통 원인에 회귀 테스트 하나만 추가합니다.

## 3. 파일 책임 맵

| 경로 | 책임 |
|---|---|
| `packages/evidence/src/schema.ts` | Workspace 결속 guard와 no-match Brief 상태 |
| `packages/evidence/src/contracts.ts` | Repository workspace binding 공개 타입 |
| `packages/evidence/src/repository-store.ts` | Workspace별 Repository 조회·멱등 등록 |
| `packages/evidence/src/index-store.ts` | building IndexVersion의 유일한 cross-file relation target 확정 |
| `packages/evidence/src/search.ts` | 첨부 상대 경로 allowlist |
| `packages/evidence/src/graph.ts` | 기존 1-hop 관계 순회 재사용 |
| `packages/evidence/src/evidence-store.ts` | Work별 Brief·no-match receipt |
| `packages/evidence/src/workspace-knowledge.ts` | capture→index→search→graph→brief 조립 |
| `packages/evidence/src/prompt-materializer.ts` | Brief·snapshot hash 검증 뒤 bounded prompt 자료화 |
| `packages/application/src/core-pipeline.ts` | Intake 준비, SharedContextReference, Context source 연결 |
| `packages/context-strategy/src/strategy-generator.ts` | 저장하지 않은 evidence 본문을 실행 직전 계획 입력에 추가 |
| `packages/application/src/core-evidence-stage.ts` | Brief freshness·Work 소유권 gate |
| `packages/application/src/core-delivery-stage.ts` | active ContextVersion 근거를 Delivery 입력에 추가 |
| `packages/application/src/core-software-task.ts` | software task에도 같은 evidence 입력 전달 |
| `packages/growth/src/prompt-memory.ts` | 개인 explicit memory 최초 version과 CAS 갱신 |
| `packages/growth/src/work-prompt-adapter.ts` | Work 생성 시 active memory를 PromptVersion에 고정 |
| `packages/growth/src/runtime-configuration.ts` | 실행별 Prompt·Memory lineage 조회 |
| `packages/application/src/contracts.ts` | 지식·기억 typed query·command |
| `packages/application/src/query-registry.ts` | Work knowledge와 개인 memory projection |
| `packages/application/src/adapters/domain.ts` | 개인 memory put/forget 명령 |
| `packages/application/src/bootstrap.ts` | Growth bootstrap 호출 |
| `apps/server/src/product.ts` | Evidence·Growth 생산 조립 |
| `apps/desktop/src/desktop-service.ts` | typed Application view 소비 |
| `apps/desktop/src/app.tsx` | Work 출처와 개선의 내 기억 UI |

## Task 1: Workspace와 Evidence Repository 결속

**Files:**

- Modify: `packages/evidence/src/schema.ts`
- Modify: `packages/evidence/src/contracts.ts`
- Modify: `packages/evidence/src/repository-store.ts`
- Modify: `packages/evidence/src/repository-store.test.ts`

- [ ] **Step 1: 현재 Repository 등록·revision replay 호출자를 모두 확인합니다.**

`RepositoryStore.register()`, `captureRevision()`, `getCurrentIndex()` 호출자를 `rg`로 확인하고 기존 `projectId` 의미는 바꾸지 않습니다.

- [ ] **Step 2: unique guard와 tenant 격리를 한 표 테스트로 고정합니다.**

같은 조직·Workspace 등록 replay는 같은 Repository를 반환하고, 다른 조직의 조회는 `undefined`, 동일 Workspace의 다른 Repository 생성은 거부되는 한 테스트만 추가합니다.

- [ ] **Step 3: optional Workspace 결속을 추가합니다.**

이미 적용된 `0025-evidence-index` migration 본문을 수정하지 않습니다. 다음 unused migration ID로 additive migration을 만들고 RepositoryStore의 migration 목록에 추가합니다.

```sql
DEFINE FIELD workspace_id ON evidence_repository TYPE option<string>;
DEFINE FIELD workspace_guard_key ON evidence_repository TYPE option<string>;
DEFINE INDEX evidence_repository_workspace_guard ON evidence_repository FIELDS workspace_guard_key UNIQUE;
```

결속된 Repository만 `workspace_guard_key = ${organizationId}:${workspaceId}`를 저장합니다. Workspace와 무관한 기존 Repository에는 해당 필드를 쓰지 않습니다. `findByWorkspace()`는 tenant 조건과 guard key를 모두 사용합니다.

- [ ] **Step 4: canonical root를 재검증합니다.**

Application adapter가 넘긴 Workspace path를 Scanner가 다시 `realpath`하고, 그 hash가 Repository `rootRealPathHash`와 다르면 색인을 거부합니다. archived·blocked Workspace는 등록·재색인하지 않습니다.

- [ ] **Step 5: 표적 검증과 커밋을 수행합니다.**

```sh
pnpm --filter @massion/evidence test -- repository-store.test.ts
pnpm --filter @massion/evidence typecheck
git add packages/evidence/src/schema.ts packages/evidence/src/contracts.ts packages/evidence/src/repository-store.ts packages/evidence/src/repository-store.test.ts
git commit -m "feat(evidence): 워크스페이스와 코드 저장소 결속" \
  -m "조직별 Workspace 하나를 Evidence Repository 하나에 멱등하게 연결하고 canonical path와 tenant 경계를 고정했습니다."
```

## Task 2: 색인·검색·코드 그래프·Brief 세로 흐름

**Files:**

- Create: `packages/evidence/src/workspace-knowledge.ts`
- Create: `packages/evidence/src/prompt-materializer.ts`
- Create: `packages/evidence/src/workspace-knowledge.test.ts`
- Modify: `packages/evidence/src/search.ts`
- Modify: `packages/evidence/src/index-store.ts`
- Modify: `packages/evidence/src/indexer.ts`
- Modify: `packages/evidence/src/evidence-store.ts`
- Modify: `packages/evidence/src/schema.ts`
- Modify: `packages/evidence/src/index.ts`

- [ ] **Step 1: 경로·checksum 경계를 한 통합 테스트로 고정합니다.**

임시 Workspace에 `src/allowed.ts`, `src/related.ts`, `src/outside.ts`와 유일한 cross-file call 관계를 만듭니다. 검색 root인 allowed에만 고유 marker를 넣고 related에는 넣지 않은 뒤 다음만 확인합니다.

- 같은 manifest replay는 같은 current IndexVersion 사용
- 서로 다른 retry command ID로 같은 Work를 준비해도 같은 EvidenceBrief ID 사용
- 파일 변경 뒤 시작한 두 번째 Work는 새 IndexVersion 사용; 첫 Work는 기존 Brief 유지
- `relativePaths` 없이 marker를 검색하면 related가 1-hop graph로 Brief에 포함됨
- `relativePaths: ["src/allowed.ts"]`이면 related·outside 결과와 graph node가 모두 나오지 않음
- target symbol 삭제 뒤 새 IndexVersion에서는 clone된 relation도 unresolved가 되어 stale edge가 남지 않음
- materialized 내용과 Brief reference의 `contentHash`가 같음

- [ ] **Step 2: 검색 allowlist를 가장 낮은 공통 경로에 추가합니다.**

`CodeSearchInput.relativePaths?: readonly string[]`을 추가합니다. absolute path, `.`·`..` segment, 빈 값, 중복, 20개 초과를 거부합니다. exact snapshot 후보, BM25 query, 선택적 embedding 후보 모두 동일 allowlist를 통과한 뒤 순위에 들어갑니다.

- [ ] **Step 3: Work별 durable no-match receipt를 추가합니다.**

이미 적용된 `0029-evidence-brief` 본문을 수정하지 않고 새 additive migration에서 status assertion을 `no_match`까지 확장하고 optional `scope_checksum`을 추가합니다. `createNoMatch()`와 `listByWork()`를 구현하되 일반 `createBrief()`의 reference 1개 이상 불변량은 유지합니다. no-match만 빈 reference를 허용하며 RepositoryRevision·IndexVersion·query·scope checksum·checksum을 저장합니다.

`scopeChecksum`은 값이 있을 때만 `briefChecksum()` canonical object에 조건부로 포함합니다. 기존 row처럼 필드가 없으면 과거 checksum 입력 모양을 그대로 유지해 이미 저장된 Brief를 깨뜨리지 않습니다.

- [ ] **Step 4: 기존 서비스만 조립합니다.**

`WorkspaceKnowledgeService.prepare()`는 다음 순서만 소유합니다.

1. `workspaceId`, 사용자 요청 앞 2,000자, 정렬된 `relativePaths`로 `scopeChecksum` 계산
2. Work별 기존 Brief가 있으면 scope·Brief checksum과 snapshot을 검증해 같은 ready/no-match Brief 반환
3. Scanner·RevisionCollector로 현재 manifest 캡처
4. manifest가 current complete index와 같으면 재사용, 다르면 `EvidenceIndexer` 실행
5. 모든 파일 stage 뒤 `IndexStore.resolveRelations()`로 전체 IndexVersion의 `imports`·`calls`·`implements` target을 현재 symbol 집합에서 재평가
6. 명시적 첨부 파일의 bounded chunk를 seed로 선택
7. 결정된 query로 exact·BM25 검색
8. 검색 symbol과 symbol-bound chunk의 `symbolKey`마다 `CodeGraphService.neighbors({ direction: "both", depth: 1 })`
9. allowlist 안의 `imports`·`calls`·`implements` 관련 symbol 최대 8개 추가
10. symbol 후보를 같은 `symbolKey`의 redacted chunk로 정규화
11. 중복 제거 후 전체 최대 12개 chunk reference로 EvidenceBrief 또는 no-match receipt 생성

Work별 `scopeChecksum`이 있는 자동 Brief는 하나만 허용하고, 필드가 없는 기존 수동 Brief는 이 경로에서 사용하지 않습니다. 기존 자동 Brief의 scope checksum이 다르면 새 Brief를 만들지 않고 invariant 오류를 냅니다. Core는 retry별 stage command ID를 전달하지 않고 Run 기준 `${runId}:knowledge`를 preparation command ID로 사용합니다. 실제 통합 테스트는 서로 다른 retry stage command를 흉내 내어 `prepare()`를 두 번 호출하고 같은 Brief ID와 SharedContext 한 건을 확인합니다.

`resolveRelations()`는 building IndexVersion에서 completion 직전에만 실행합니다. target text의 마지막 identifier가 전체 symbol name 또는 qualified name에서 정확히 하나와 일치할 때만 resolved target을 저장합니다. target이 없거나 모호하면 clone된 기존 target도 지우며, 후보를 점수나 파일 근접도로 추측하지 않습니다.

새 queue, watcher, background indexer는 만들지 않습니다. v1 색인은 Work Intake가 동기 실행하며, 실제 지연이 UAT를 막을 때만 background 작업을 설계합니다.

- [ ] **Step 5: prompt materializer를 추가합니다.**

`EvidencePromptMaterializer`는 EvidenceBrief와 정확한 IndexVersion snapshot을 다시 읽고, 이 생산 흐름이 만든 chunk reference의 path·range·content hash를 검증한 뒤 redacted content, citation, estimated token 수를 반환합니다. symbol search·graph 결과는 Brief 생성 전에 chunk로 정규화하므로 source file hash와 prompt slice hash를 혼동하지 않습니다. ContextVersion에는 이 본문을 저장하지 않습니다. 한 Work의 prompt 총량은 12 references와 24,000 estimated tokens로 제한합니다.

기존 RuntimeExecution은 실제 Agent input을 `input_json`에 저장하므로 materialized redacted snippet도 로컬 감사 기록에 남습니다. Representative·Strategy·Delivery의 `estimatedTokens`는 materialized token 수를 포함하고, 각 stage의 남은 token budget을 넘는 reference는 rank 뒤에서 잘라냅니다.

- [ ] **Step 6: Evidence 패키지를 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/evidence test
pnpm --filter @massion/evidence typecheck
git add packages/evidence/src/schema.ts packages/evidence/src/search.ts packages/evidence/src/index-store.ts packages/evidence/src/indexer.ts packages/evidence/src/evidence-store.ts packages/evidence/src/workspace-knowledge.ts packages/evidence/src/prompt-materializer.ts packages/evidence/src/workspace-knowledge.test.ts packages/evidence/src/index.ts
git commit -m "feat(evidence): 코드 지식 세로 흐름 복원" \
  -m "기존 Scanner·Tree-sitter·BM25·CodeGraph를 조립해 첨부 경로 안의 검색·1-hop 관계·EvidenceBrief와 검증된 prompt materialization을 제공합니다."
```

## Task 3: Work·대화·Agent 실행에 지식 연결

**Files:**

- Modify: `packages/application/src/core-pipeline.ts`
- Modify: `packages/application/src/core-pipeline.test.ts`
- Modify: `packages/work/src/work.ts`
- Modify: `packages/work/src/collaboration.test.ts`
- Modify: `packages/context-strategy/src/strategy-generator.ts`
- Modify: `packages/context-strategy/src/strategy-generator.test.ts`
- Modify: `packages/application/src/core-evidence-stage.ts`
- Modify: `packages/application/src/core-delivery-stage.ts`
- Modify: `packages/application/src/core-software-task.ts`
- Modify: `packages/software-engineering/src/runtime.ts`
- Modify: `packages/software-engineering/src/runtime.test.ts`
- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `apps/server/src/product.ts`
- Modify: `apps/server/src/product.test.ts`

- [ ] **Step 1: 하나의 lineage 경계 테스트를 추가합니다.**

fake knowledge adapter가 반환한 Brief가 최초 실행과 Intake retry 뒤에도 다음 네 지점에서 같은 ID·checksum을 한 번만 쓰는지 검사합니다.

1. Core Office `SharedContextReference`
2. ContextVersion metadata-only evidence source
3. Strategy·Delivery materialized prompt citation
4. `work.knowledge` typed view

- [ ] **Step 2: Intake에서 지식을 한 번 준비합니다.**

Core request의 기존 `workspaceId`, `workspacePaths`, `text`를 사용합니다. Work와 Core Office room을 만든 뒤 trusted Workspace일 때만 Run 기준의 안정적인 command ID로 `prepare()`를 호출합니다. `prepare()`가 먼저 Work별 기존 Brief를 검증·재사용하므로 Intake retry가 새 Brief를 만들지 않습니다.

`WorkService`에는 기존 schema를 그대로 읽는 `listSharedContexts(context, workId, roomId)`만 추가합니다. ready Brief를 연결할 때 다음 계약을 사용합니다.

```ts
{
  commandId: `${runId}:knowledge-shared:${brief.evidenceBriefId}`,
  workId,
  expectedRevision: (await works.getWork(context, workId)).revision,
  roomId: room.room_id,
  sourceKind: "evidence-brief",
  sourceId: brief.evidenceBriefId,
  versionId: brief.indexVersionId,
  checksum: brief.checksum,
}
```

호출 전에 `(roomId, sourceKind, sourceId, versionId)`가 같은 reference를 조회합니다. 있으면 checksum이 같은지 확인하고 건너뛰며, 다르면 fail closed합니다. 따라서 retry별 stage command ID가 달라져도 unique index 충돌이나 Work revision replay 충돌을 만들지 않습니다. 새 reference일 때만 방 생성 이후의 최신 Work revision으로 `addSharedContext()`를 호출합니다. materialized payload는 Representative 입력에 추가하고, no-match receipt는 화면에는 남기되 Context source나 Agent 본문으로 보내지 않습니다.

- [ ] **Step 3: ContextVersion에는 reference만 고정합니다.**

`EvidenceContextBinder`를 `policy: "warn"`으로 호출해 반환된 `content` 없는 source를 Context & Strategy 입력에 추가합니다. `ContextStore`의 “evidence content 복제 금지” 불변량은 유지합니다.

`context-strategy` 패키지는 `evidence` 패키지에 의존하지 않으므로, `StrategyGenerator`에 선택적인 작은 prompt resolver port만 추가합니다. registry나 factory는 만들지 않습니다. server가 `EvidencePromptMaterializer` adapter 하나를 주입하며, generator는 runtime 호출 직전에 `evidenceMaterials`를 별도 필드로 넣습니다.

- [ ] **Step 4: Evidence 단계는 freshness gate만 수행합니다.**

request payload의 임의 `evidenceBriefIds`를 정본으로 삼지 않습니다. Work의 active ContextVersion에 선택된 evidence source를 읽고 그 Brief의 Work 소유권, ready 상태, snapshot 존재와 checksum을 검증합니다. evidence source가 없으면 `listByWork()`의 no-match receipt 또는 Workspace 없음만 정상으로 인정합니다. current IndexVersion이 달라도 계획 당시 snapshot이 온전하면 `stale_warning`으로 계속 진행합니다. snapshot 손상 또는 다른 Work면 `evidence-invalid`로 block합니다. 검색·색인은 다시 실행하지 않습니다.

- [ ] **Step 5: Delivery와 software task에 같은 근거를 전달합니다.**

Work의 active ContextVersion을 읽고 선택된 evidence source를 materialize합니다. 일반 Delivery `execute_work_task`와 `CoreSoftwareTaskPort.executeTask()` 모두 같은 bounded `knowledgeSources`와 검증된 Brief ID를 받습니다. metadata-only 또는 hash 불일치 source는 조용히 생략하지 않고 block합니다.

`CoreSoftwareTaskAdapter`는 request의 임의 `softwareDelivery.evidenceBriefIds`를 모델 근거의 정본으로 쓰지 않고 active Context에서 받은 값만 `SoftwarePatchProposalService.propose()`에 전달합니다. `SoftwarePatchProposalRequest`와 실제 structured runner input에 redacted content·citation을 추가하고, Brief ID는 assurance lineage용으로 함께 유지합니다.

- [ ] **Step 6: typed `work.knowledge`를 추가합니다.**

설계 문서의 `WorkKnowledgeViewV1`을 반환하고, reference마다 사람이 읽는 path·symbol·line range를 포함합니다. ready Work는 active ContextVersion의 evidenceRef를 정본으로 사용하고, no-match는 Work별 receipt를 사용합니다. freshness는 조회 시 current IndexVersion과 비교해 계산합니다. Work→ContextVersion→EvidenceBrief→source와 Work→Room·Message·Artifact 관계는 기존 ID로 재구성합니다. 검색 방식이나 graph 유입 이유를 위한 새 provenance 필드는 만들지 않고, 새 graph edge table도 추가하지 않습니다.

- [ ] **Step 7: 기존 blocked retry를 연결합니다.**

지식 전용 retry command를 만들지 않습니다. Intake 색인 또는 실행 단계 materialize의 일시 실패는 현재 Run ID로 기존 `run.resume({ retryBlocked: true })` 경로를 사용합니다. stale snapshot은 같은 stage 재시도로 갱신되지 않으므로 재시도 버튼을 보이지 않고 새 Work에서 current snapshot을 사용한다는 안내를 제공합니다.

- [ ] **Step 8: 표적 검증과 커밋을 수행합니다.**

```sh
pnpm --filter @massion/context-strategy test
pnpm --filter @massion/application test
pnpm --filter @massion/application typecheck
pnpm --filter @massion/software-engineering test
git add packages/work/src/work.ts packages/work/src/collaboration.test.ts packages/context-strategy/src/strategy-generator.ts packages/context-strategy/src/strategy-generator.test.ts packages/software-engineering/src/runtime.ts packages/software-engineering/src/runtime.test.ts packages/application/src/core-pipeline.ts packages/application/src/core-pipeline.test.ts packages/application/src/core-evidence-stage.ts packages/application/src/core-delivery-stage.ts packages/application/src/core-software-task.ts packages/application/src/contracts.ts packages/application/src/query-registry.ts apps/server/src/product.ts apps/server/src/product.test.ts
git commit -m "feat(core): 코드 근거를 Work와 Agent 실행에 연결" \
  -m "EvidenceBrief를 Core Office 방과 ContextVersion에 고정하고 Representative·Strategy·Delivery가 같은 검증된 citation을 사용하게 했습니다."
```

## Task 4: 개인 explicit 기억 계약 복원

**Files:**

- Modify: `packages/growth/src/prompt-memory.ts`
- Modify: `packages/growth/src/prompt-memory.test.ts`
- Modify: `packages/growth/src/gateway.ts`
- Create: `packages/growth/src/gateway.test.ts`
- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/adapters/domain.ts`
- Modify: `packages/application/src/query-registry.ts`

- [ ] **Step 1: 기억 권위와 version 경계를 한 표 테스트로 고정합니다.**

최초 `expectedRevision: 0` 생성, 같은 revision replay, stale revision 거부, put, forget, 다른 user 접근 거부를 한 표 테스트에 넣습니다.

- [ ] **Step 2: 기존 저장 형식과 checksum을 유지합니다.**

`MemoryEntry` persisted JSON에 새 필드를 추가하지 않습니다. public command로 생성한 `scope:user`, `subjectId: context.userId` entry만 Application view에서 `authority: "explicit"`로 표시합니다. learned·organization·agent scope 쓰기는 이 command에서 열지 않습니다.

- [ ] **Step 3: 최초 user MemoryVersion을 허용합니다.**

`PromptMemoryStore.activateMemory()`는 user scope에 current version이 없고 `expectedVersion === 0`일 때만 parent 없는 첫 version을 만듭니다. current가 있으면 기존 CAS와 immutable supersede를 그대로 사용합니다.

- [ ] **Step 4: 최소 command를 추가합니다.**

- `growth.memory.put`: 현재 entry 목록에서 key를 교체 또는 추가
- `growth.memory.forget`: 현재 entry 목록에서 key를 제외한 새 version 생성

`GrowthGateway`에 이 두 사용자 범위 동작을 추가하고 Application adapter는 façade만 호출합니다. payload는 `key`, `kind`, `value`만 받으며 scope·subject·authority·source ID를 받지 않습니다. source reference는 command lineage에서 내부 생성합니다. 공개 경계는 key 120자, value 4,000자, active 100개로 제한하고 기존 보안 검사를 재사용합니다.

UI의 “앞으로 사용하지 않음”은 hard delete가 아닙니다. 과거 PromptVersion·RuntimeExecution·Records checksum은 바꾸지 않습니다.

- [ ] **Step 5: typed `growth.memories`를 확장합니다.**

현재 user MemoryVersion의 revision과 entry key·kind·value·derived authority를 반환합니다. 내부 organization memory 원문은 `내 기억` 목록에 섞지 않습니다.

- [ ] **Step 6: Growth·Application을 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/growth test
pnpm --filter @massion/application test -- adapters/domain.test.ts query-registry.test.ts
git add packages/growth/src/prompt-memory.ts packages/growth/src/prompt-memory.test.ts packages/growth/src/gateway.ts packages/growth/src/gateway.test.ts packages/application/src/contracts.ts packages/application/src/adapters/domain.ts packages/application/src/query-registry.ts
git commit -m "feat(memory): 개인 명시적 기억 계약 복원" \
  -m "사용자 범위 MemoryVersion의 최초 생성, CAS 갱신과 앞으로 사용하지 않기를 기존 checksum 형식을 유지한 채 typed 명령으로 연결했습니다."
```

## Task 5: PromptVersion·RuntimeExecution 생산 조립

**Files:**

- Modify: `packages/application/src/bootstrap.ts`
- Modify: `packages/application/src/bootstrap.test.ts`
- Modify: `packages/application/src/product.ts`
- Modify: `packages/growth/src/index.ts`
- Modify: `apps/server/src/product.ts`
- Modify: `apps/server/src/product.test.ts`

- [ ] **Step 1: 현재 생산 생성 순서를 기록합니다.**

`WorkService`, `RuntimeExecutionStore`, `OrganizationAgentTopology`, `LocalApplicationBootstrap` 생성 지점을 다시 확인하고 테스트 전용 조립은 변경하지 않습니다.

- [ ] **Step 2: 기존 Growth seam을 주입합니다.**

먼저 `GrowthWorkPromptAdapter`와 `GrowthAgentConfigurationReader`를 `@massion/growth` 루트에서 export합니다. server가 내부 파일 경로를 직접 import하지 않습니다.

```ts
const promptMemory = await PromptMemoryStore.create(database, organizations);
const promptAdapter = new GrowthWorkPromptAdapter(database, organizations, promptMemory);
const works = await WorkService.create(database, organizations, graph, governanceGate, promptAdapter);

const configuration = new GrowthAgentConfigurationReader(database, organizations, promptMemory);
const runtimeExecutions = await RuntimeExecutionStore.create(database, organizations, configuration);
const instructions = new AgentInstructionRegistry(configuration);
```

`OrganizationAgentTopology`에 `instructions`를 전달합니다. `EmbeddedVoltAgentRuntime`의 `memory: false`는 유지해 Work·Room·Message와 이중 대화 저장소를 만들지 않습니다.

- [ ] **Step 3: bootstrap을 한 번만 연결합니다.**

`ApplicationProductDependencies`에 기존 `GrowthBootstrap.start()`를 호출할 optional dependency를 추가하고, Core Office·policy 준비 뒤 실행합니다. 반복 bootstrap은 기존 active PromptDefinition·organization Memory·평가 전략을 재사용합니다.

- [ ] **Step 4: 한 생산 조립 테스트로 lineage를 확인합니다.**

기억 저장 전 Work와 저장 후 Work를 각각 만들고, 뒤 Work만 새 user MemoryVersion을 PromptVersion과 RuntimeExecution `memory_version_ids`에 포함하는지 확인합니다. 앞 Work의 lineage는 변하지 않아야 합니다.

- [ ] **Step 5: 관련 패키지를 검증하고 커밋합니다.**

```sh
pnpm --filter @massion/work test
pnpm --filter @massion/runtime test
pnpm --filter @massion/application test
pnpm --filter @massion/server test
git add packages/growth/src/index.ts packages/application/src/bootstrap.ts packages/application/src/bootstrap.test.ts packages/application/src/product.ts apps/server/src/product.ts apps/server/src/product.test.ts
git commit -m "feat(core): 지식과 기억을 생산 Agent 실행에 조립" \
  -m "Growth의 기존 seam을 server product에 주입해 새 Work가 고정된 memory lineage를 실제 Agent instruction과 RuntimeExecution에서 사용하게 했습니다."
```

## Task 6: 데스크톱 출처와 내 기억 UI

**Files:**

- Modify: `apps/desktop/src/desktop-service.ts`
- Modify only if a structural failure is found: `apps/desktop/src/desktop-service.test.ts`
- Modify: `apps/desktop/src/app.tsx`
- Modify only if a structural failure is found: `apps/desktop/src/app.integration.test.tsx`

- [ ] **Step 1: DesktopService에 typed 계약만 연결합니다.**

```ts
loadWorkKnowledge(workId: string): Promise<WorkKnowledgeViewV1>;
putExplicitMemory(input: { key: string; kind: MemoryKind; value: string; revision: number }): Promise<void>;
forgetExplicitMemory(input: { key: string; revision: number }): Promise<void>;
```

새 `unknown` parser나 별도 cache를 만들지 않습니다.

- [ ] **Step 2: Work 상세에 `사용한 지식`을 추가합니다.**

- ready: 실제 사용한 path, symbol, line range, fresh/stale snapshot
- no-match: 검색은 했지만 근거가 없다는 상태
- blocked: 사용자에게 읽히는 원인과 기존 Run 재시도 행동
- reference 선택: 같은 Work의 Shared Context 출처로 이동

내부 Repository·Index ID와 전역 graph explorer는 기본 화면에 노출하지 않습니다.

- [ ] **Step 3: 개선 표면에 `내 기억`을 추가합니다.**

key·kind·value 입력, `다음 새 업무부터 적용`, 현재 revision, explicit 표식, `앞으로 사용하지 않음`을 제공합니다. stale revision이면 목록을 다시 읽고 사용자가 재검토하게 하며 자동 덮어쓰지 않습니다.

- [ ] **Step 4: 실제 화면을 먼저 확인합니다.**

기존 통합 테스트를 실행한 뒤 개발 앱에서 ready/no-match/blocked와 put/forget을 조작합니다. 구조적 실패가 확인된 경우에만 `app.integration.test.tsx`에 회귀 테스트 하나를 추가합니다.

- [ ] **Step 5: 검증하고 커밋합니다.**

```sh
pnpm exec eslint apps/desktop/src
pnpm --filter @massion/desktop typecheck
pnpm --filter @massion/desktop test
git add apps/desktop/src/desktop-service.ts apps/desktop/src/app.tsx
# 구조적 실패로 회귀 테스트를 추가한 경우에만 해당 테스트 파일도 별도로 stage합니다.
git commit -m "feat(desktop): Work 지식 출처와 개인 기억 연결" \
  -m "실제 Agent가 사용한 파일·심볼 citation과 다음 Work에 적용되는 explicit memory를 각 소유 화면에서 관리하게 했습니다."
```

## Task 7: 실제 UAT와 확장 판단

**Files:**

- Create: `docs/evidence/phase-30/knowledge-memory-uat-YYYY-MM-DD.md`
- Modify: `docs/generated/requirements-traceability.tsv`
- Modify: `PRODUCT.md`
- Modify: `docs/product/constitution.md`

- [ ] **Step 1: 같은 후보 SHA에서 패키지 gate를 실행합니다.**

```sh
pnpm --filter @massion/evidence test
pnpm --filter @massion/growth test
pnpm --filter @massion/context-strategy test
pnpm --filter @massion/runtime test
pnpm --filter @massion/application test
pnpm --filter @massion/server test
pnpm --filter @massion/desktop test
pnpm --filter @massion/desktop typecheck
```

- [ ] **Step 2: 실제 Tauri 앱에서 UAT-K01~K04를 실행합니다.**

Computer Use로 접근성 트리를 매 행동 뒤 다시 읽습니다. 키, 전체 홈 경로, 개인 이메일, 기억 value 원문은 evidence 문서와 스크린샷에 남기지 않습니다.

- [ ] **Step 3: read-only 데이터 조회로 계보를 확인합니다.**

같은 Work의 Workspace, RepositoryRevision, IndexVersion, EvidenceBrief, SharedContextReference, ContextVersion, PromptVersion, RuntimeExecution memory version이 연결되는지 확인합니다. evidence content와 memory value는 checksum과 redacted 요약만 기록합니다.

- [ ] **Step 4: 실패 종류에 따라 확장 여부를 판정합니다.**

- cross-file definition/reference 누락이 UAT를 반복 차단함 → LSP adapter 별도 계획
- 동의어·개념 검색 실패가 핵심 시나리오를 반복 차단함 → embedding provider·vector index 별도 계획
- 1-hop 순회가 실제 규모에서 병목임이 측정됨 → SurrealDB native relation·DB traversal 별도 계획

실패 근거가 없으면 세 항목은 구현하지 않고 `deferred`로 기록합니다.

- [ ] **Step 5: 추적표와 증거를 실제 값으로 갱신합니다.**

`REQ-KNOWLEDGE-001`, `REQ-KNOWLEDGE-002`, `REQ-MEMORY-001`, `REQ-KNOWLEDGE-UAT-001`의 test·commit·event·metric·evidence를 실제 값으로 바꾸고 완료 조건을 충족한 행만 `completed`로 표시합니다.

- [ ] **Step 6: 증거를 커밋합니다.**

```sh
git add docs/evidence/phase-30/knowledge-memory-uat-YYYY-MM-DD.md docs/generated/requirements-traceability.tsv PRODUCT.md docs/product/constitution.md
git commit -m "docs(phase-30): 지식과 기억 실사용 근거 기록" \
  -m "Workspace 코드 그래프·RAG citation과 explicit memory 적용·사용 중지의 실제 데스크톱 결과를 같은 후보 SHA에 결속했습니다."
```

## 4. 전체 완료 게이트

- [ ] Workspace current snapshot이 versioned index로 만들어지고 unchanged snapshot은 재사용됩니다.
- [ ] 첨부 경로 밖의 source와 graph node가 검색·prompt·화면에 나오지 않습니다.
- [ ] 기존 relation 1-hop이 실제 Brief reference에 포함됩니다.
- [ ] EvidenceBrief checksum과 Representative·Strategy·Delivery citation이 같은 file range를 가리킵니다.
- [ ] Core Office 방에서 같은 Brief의 SharedContextReference를 읽을 수 있습니다.
- [ ] explicit memory가 새 Work PromptVersion·RuntimeExecution에만 적용됩니다.
- [ ] 앞으로 사용하지 않기 뒤 새 Work memory lineage에서 해당 key가 사라집니다.
- [ ] 다른 tenant·user·Workspace ID 추측이 모두 거부됩니다.
- [ ] UAT-K01~K04와 Phase 30 Core UAT가 같은 후보 SHA에서 통과합니다.
- [ ] LSP·embedding·native relation 미구현 상태를 구현 완료로 표시하지 않습니다.
