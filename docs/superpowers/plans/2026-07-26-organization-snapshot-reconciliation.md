# Phase 30 실제 조직 snapshot 정합화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `subagent-driven-development`로 한 Task씩 구현하고, 각 Task 뒤 명세 검토와 품질 검토를 수행합니다. 모든 단계는 체크박스(`- [ ]`)로 추적합니다.

**Goal:** 실제 Tauri 앱에서 저장된 조직의 식별자·부모 관계·범위·업무 소속이 끊기지 않고 데스크톱 구조와 지도에 같은 계층으로 나타나게 합니다.

**Architecture:** `organization_node`의 정본 필드를 Application read model에서 camelCase source로 보존하고, collaboration snapshot에는 내부 표현으로, `organization.graph.snapshot` query에는 공개 snake_case DTO로 명시적으로 투영합니다. 데스크톱은 그 DTO만 읽어 구조·지도·선택 상태를 공유합니다. 일반 collaboration snapshot의 기존 형태를 화면 계약으로 재사용하지 않습니다.

**Tech Stack:** TypeScript 5.9, SurrealDB read model, `@massion/application`, React 19, Vitest, Tauri 2.

**재현 근거:** 후보 `f4450c52df57ad402ab57c2946a7fc5cb1f1a6bc`의 실제 `Massion.app`에서 지도에는 Iris·Lyra 등 8개 Core Agent가 표시되지만 구조에는 부모가 없는 Iris 한 행만 표시됐습니다. `packages/application/src/adapters/read-model.ts`가 `node_id`·`parent_handle`·`work_id`을 SELECT하지 않고, `snapshot.ts`와 query handler도 이를 보존하지 않는 것이 원인입니다.

**범위 밖:** 이 작업은 아직 공개 command가 없는 조직 drag·영향 미리보기·승인·제안 생성 기능을 발명하지 않습니다. 해당 기능은 정본 Phase 30 Task 6의 별도 command 계약이 준비된 뒤 구현합니다.

---

## Task 1: 실제 계층 손실을 query 계약 테스트로 고정

**Files:**

- Modify: `packages/application/src/snapshot.test.ts`
- Modify: `packages/application/src/query-registry.test.ts`

- [x] **Step 1: snapshot fixture에 루트와 자식의 정본 계층 필드를 추가합니다.**

`source()`의 organization fixture를 다음처럼 최소 두 노드로 만듭니다. root에는 `parentHandle`과 `workId`를 넣지 않고, 자식에는 root handle을 넣습니다.

```ts
nodes: [
  {
    nodeId: "node-representative",
    handle: "representative",
    name: "Iris",
    responsibility: "사용자 요청 조정",
    capabilities: ["request-coordination"],
    status: "active",
    role: "orchestrator",
    scope: "persistent",
  },
  {
    nodeId: "node-strategy",
    handle: "strategy",
    name: "Lyra",
    responsibility: "맥락 구성",
    capabilities: ["analysis"],
    parentHandle: "representative",
    status: "active",
    role: "coordinator",
    scope: "persistent",
  },
],
```

- [x] **Step 2: public `organization.graph.snapshot`의 실패하는 기대값을 추가합니다.**

`query-registry.test.ts`에서 `new CollaborationGraphSnapshotProjector(readModel)`을 `snapshot` dependency로 등록하고, `organization.graph.snapshot` 결과가 다음 DTO를 반환한다고 단언합니다.

```ts
expect(result.data).toMatchObject({
  version: { version: 1 },
  nodes: [
    { node_id: "node-representative", scope: "persistent" },
    {
      node_id: "node-strategy",
      handle: "strategy",
      parent_handle: "representative",
      scope: "persistent",
    },
  ],
});
```

- [x] **Step 3: 집중 테스트가 현재 구현에서 실패하는지 확인합니다.**

Run: `pnpm --filter @massion/application test -- snapshot.test.ts query-registry.test.ts`

Expected: FAIL. 현재 handler는 `CollaborationGraphSnapshot`을 그대로 반환하므로 `data.version`과 `node_id`·`parent_handle`이 없습니다.

## Task 2: 저장소에서 snapshot까지 계층 필드를 보존

**Files:**

- Modify: `packages/application/src/read-model.ts`
- Modify: `packages/application/src/adapters/read-model.ts`
- Modify: `packages/application/src/adapters/read-model.test.ts`
- Modify: `packages/application/src/snapshot.ts`
- Modify: `packages/application/src/snapshot.test.ts`

- [x] **Step 1: read model source의 명시적 필드를 정의합니다.**

`ApplicationOrganizationNodeSource`에 아래 필드를 추가합니다. source 안에서는 camelCase만 사용합니다.

```ts
readonly nodeId: string;
readonly parentHandle?: string;
readonly workId?: string;
```

`scope`은 기존 값과 같은 `"persistent" | "work"`로 좁힙니다. 데이터베이스 값이 이 둘 밖이면 adapter에서 오류가 나야 하며 빈 문자열이나 임의 기본값으로 바꾸지 않습니다.

- [x] **Step 2: read model adapter가 정본 column을 모두 읽고 변환하게 합니다.**

`OrganizationNodeRecord`에 `node_id`, `parent_handle?`, `work_id?`를 추가하고 SELECT를 다음 필드를 포함하도록 바꿉니다.

```sql
SELECT node_id, handle, name, responsibility, capabilities, parent_handle, status, role, scope, work_id
FROM organization_node
WHERE organization_id = $organization_id
ORDER BY handle ASC;
```

반환 mapping은 다음 형태를 사용합니다.

```ts
{
  nodeId: node.node_id,
  handle: node.handle,
  name: node.name,
  responsibility: node.responsibility,
  capabilities: node.capabilities,
  ...(node.parent_handle === undefined ? {} : { parentHandle: node.parent_handle }),
  status: node.status,
  role: node.role,
  scope: node.scope,
  ...(node.work_id === undefined ? {} : { workId: node.work_id }),
}
```

- [x] **Step 3: collaboration snapshot이 필드를 버리지 않게 합니다.**

`CollaborationGraphNode`에 `nodeId`, `parentHandle?`, `workId?`를 추가하고, `CollaborationGraphSnapshotProjector.map()`에서 source의 동일 필드를 그대로 복사합니다. current task/work/execution의 실행 상태 필드는 기존대로 별도 유지합니다.

- [x] **Step 4: 실제 Surreal read model 회귀를 추가합니다.**

`adapters/read-model.test.ts`의 이미 bootstrap된 Core Office context에서 representative가 아닌 한 노드를 골라 다음을 검증합니다.

```ts
const organization = await readModel.organization(context);
expect(organization.nodes.find((node) => node.handle === "strategy")).toMatchObject({
  nodeId: expect.any(String),
  parentHandle: "representative",
  scope: "persistent",
});
```

`workId`는 persistent Core Office에서 존재하지 않는 것도 함께 단언합니다. 별도의 synthetic database fixture나 mock table은 만들지 않습니다.

- [x] **Step 5: Application 집중 테스트를 통과시킵니다.**

Run: `pnpm --filter @massion/application test -- adapters/read-model.test.ts snapshot.test.ts query-registry.test.ts`

Expected: PASS. read model·내부 snapshot이 parent relation을 보존하고 기존 tenant/secret regression도 계속 통과합니다.

## Task 3: 공개 DTO와 데스크톱 투영을 실제 계층에 맞춤

**Files:**

- Modify: `packages/application/src/contracts.ts`
- Modify: `packages/application/src/query-registry.ts`
- Modify: `packages/application/src/query-registry.test.ts`
- Modify: `apps/desktop/src/desktop-service.ts`
- Modify: `apps/desktop/src/desktop-service.test.ts`
- Modify: `apps/desktop/src/app.tsx`

- [x] **Step 1: public Organization DTO에 scope와 work id를 추가합니다.**

`OrganizationNodeViewV1`에 다음만 추가합니다.

```ts
readonly scope: "persistent" | "work";
readonly work_id?: string;
```

`node_id`, `parent_handle`의 snake_case는 이미 public DTO 문법이므로 camelCase alias를 추가하지 않습니다.

- [x] **Step 2: query registry에 전용 mapper를 둡니다.**

`query-registry.ts`에 `organizationGraphSnapshotView(snapshot)` 같은 file-local pure mapper를 추가합니다. mapper는 일반 collaboration snapshot을 다음 public shape으로 변환해야 합니다.

```ts
{
  version: { version: snapshot.organization.version },
  nodes: snapshot.nodes.map((node) => ({
    node_id: node.nodeId,
    handle: node.handle,
    name: node.name,
    responsibility: node.responsibility,
    ...(node.parentHandle === undefined ? {} : { parent_handle: node.parentHandle }),
    status: node.status,
    role: node.role,
    capabilities: node.capabilities,
    scope: node.scope,
    ...(node.workId === undefined ? {} : { work_id: node.workId }),
  })),
}
```

`organization.graph.snapshot` handler는 raw `dependencies.snapshot.project(context)` 대신 이 mapper의 결과만 반환합니다. collaboration snapshot 전체를 이 API의 우연한 공개 계약으로 노출하지 않습니다.

- [x] **Step 3: desktop projection이 공개 DTO의 모든 조직 필드를 보존하게 합니다.**

`OrganizationNodeView`에 `workId?`를 추가하고 `projectOrganization()`에서 `scope`·`work_id`를 그대로 camelCase로 옮깁니다.

```ts
...(node.parent_handle === undefined ? {} : { parentHandle: node.parent_handle }),
scope: node.scope,
...(node.work_id === undefined ? {} : { workId: node.work_id }),
```

`desktop-service.test.ts`에 parent가 있는 persistent node와 work scope node 하나를 반환하는 `organization.graph.snapshot` mock을 넣고, `loadOrganization()` 결과의 `id`, `parentHandle`, `scope`, `workId`를 단언합니다.

- [x] **Step 4: map node의 중복 선택 호출을 제거합니다.**

`app.tsx`의 `OrgMapNode` 클릭 handler는 정확히 한 번만 `onSelect(node.handle)`을 호출해야 합니다.

```tsx
onClick={() => {
  onSelect(node.handle);
}}
```

선택 상태·조상 펼침·`scrollIntoView` 로직은 이미 `OrganizationSurface.select`에 있으므로 새 synchronization state나 이벤트 bus를 만들지 않습니다.

- [x] **Step 5: desktop·Application 검증을 통과시킵니다.**

Run: `pnpm --filter @massion/application test -- query-registry.test.ts snapshot.test.ts adapters/read-model.test.ts && pnpm --filter @massion/desktop test -- desktop-service.test.ts && pnpm --filter @massion/desktop typecheck && git diff --check`

Expected: PASS. fixture world가 아니라 typed public DTO가 hierarchy field를 받는 회귀를 막습니다.

- [x] **Step 6: 코드만 한 개의 독립 커밋으로 만듭니다.**

```sh
git add packages/application/src/read-model.ts packages/application/src/adapters/read-model.ts packages/application/src/adapters/read-model.test.ts packages/application/src/snapshot.ts packages/application/src/snapshot.test.ts packages/application/src/contracts.ts packages/application/src/query-registry.ts packages/application/src/query-registry.test.ts apps/desktop/src/desktop-service.ts apps/desktop/src/desktop-service.test.ts apps/desktop/src/app.tsx
git commit -m "fix(organization): 실제 계층 snapshot을 데스크톱 계약에 보존" -m "node ID·부모·범위·업무 소속을 read model부터 public 조직 DTO까지 유지해 구조와 지도가 같은 실데이터를 사용하게 했습니다."
```

## Task 4: 동일 후보 번들의 실제 Tauri 재검증과 evidence

**Files:**

- Create: `docs/evidence/phase-30/organization-live-uat-2026-07-26.md`

- [ ] **Step 1: 수정 commit에서 새 `Massion.app`을 빌드합니다.**

Run: `pnpm --filter @massion/desktop tauri:build`

Expected: exit 0. bundle의 Node·SurrealDB SHA-256은 `runtime-manifest.json`과 일치해야 합니다.

- [ ] **Step 2: 격리 XDG data로 정확한 bundle executable을 열고 조직 화면을 확인합니다.**

새 temporary `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`을 사용합니다. 설치된 `/Applications/Massion.app` 이름으로 조회하거나 기동하지 않습니다.

Computer Use acceptance:

1. 조직 구조에 Iris root와 parent가 있는 Core Agent 행이 함께 보인다.
2. 지도에서 Lyra를 선택하면 같은 Lyra가 구조에서 선택되고 필요한 조상이 열린다.
3. 구조에서 다른 Agent를 선택하면 지도 selection과 center가 바뀐다.
4. work scope node가 있을 때만 provisional wording과 점선 문법을 사용한다.

- [ ] **Step 3: evidence에 후보·관찰·제약을 기록합니다.**

evidence에는 commit SHA, bundle path의 마지막 두 경로 segment, masked temporary XDG root, UI 행동, screenshot filename, 결과만 기록합니다. token·개인 홈 경로·Provider secret은 쓰지 않습니다. drag/proposal command는 범위 밖이라 미실행으로 명시합니다.

- [ ] **Step 4: evidence를 별도 커밋합니다.**

```sh
git add docs/evidence/phase-30/organization-live-uat-2026-07-26.md
git commit -m "docs(evidence): 실제 조직 구조와 지도 UAT를 기록" -m "같은 후보 번들에서 hierarchy projection과 양방향 선택 동기화 결과를 재현 가능한 범위로 남겼습니다."
```

## 완료 조건

- [x] 실제 read model query가 `node_id`·`parent_handle`·`scope`·`work_id`을 유실하지 않습니다.
- [x] public `organization.graph.snapshot`은 collaboration snapshot 내부 표현이 아니라 안정된 Organization DTO를 반환합니다.
- [ ] desktop fixture가 아닌 실제 Tauri bundle에서 구조·지도 selection이 같은 노드를 가리킵니다.
- [x] 현재 공개 command가 없는 drag·조직 제안은 구현 완료로 주장하지 않습니다.

## Self-review

- 실제 UAT가 증명한 “지도 8개 / 구조 1개” 실패는 Task 1~4가 모두 다룹니다.
- 저장소, internal snapshot, public DTO, desktop projection의 네 경계가 각각 한 Task에 명시돼 있습니다.
- 새 command, UI abstraction, drag protocol, fake fixture를 추가하지 않아 발견된 결함보다 범위가 넓어지지 않습니다.
