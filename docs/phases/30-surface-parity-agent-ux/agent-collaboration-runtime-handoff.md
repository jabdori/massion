# 핸드오프 — 에이전트 협업을 협업방에 기록

> **상태:** 미구현. 다른 에이전트가 이어받도록 작성한 인계 문서
> **작성일:** 2026-07-23
> **요구사항:** `REQ-AGENT-HARNESS-001` (요구사항 추적표 `in-progress`)
> **관련 갭:** [제품 헌법 9.4](../../product/constitution.md), [아키텍처 7절](../../architecture/README.md)

## 1. 무엇이 없는가

협업방 도메인과 VoltAgent 위임은 **각각 구현돼 있고 서로 연결돼 있지 않습니다.**

에이전트가 서로에게 일을 넘기고 답하는 과정이 VoltAgent 메모리에서만 일어나고 `collaboration_message`에 남지 않습니다. 그래서 실제 방에는 Work당 메시지가 두 건뿐입니다.

| | 상태 | 근거 |
|---|---|---|
| 협업방 도메인 | 구현됨 | `packages/work/src/collaboration.test.ts` — 10종 메시지 타입, `reply`·`caused-by` 인과, 동시 커밋의 고유 sequence, 라운드·token·비용·deadline 한계, 참여·이탈, Shared Context Reference, versioned lease |
| VoltAgent 위임 | 구현됨 | `packages/runtime/src/voltagent-topology.ts` — 조직 그래프를 supervisor·subAgent로 배선 |
| 위임을 방에 기록 | **없음** | `packages/runtime/src` 전체에 `postMessage` 호출 0건 |
| Shared Context·Lease 사용 | **없음** | 생산 호출 0건 |

이것은 제품 헌법 4.4 *"모델의 transcript만으로 조직 상태나 완료를 복원하지 않는다"*를 지키지 못하는 지점입니다. 재시작하면 협업 과정이 사라지고, 감사할 수 없으며, 사용자가 볼 수 없습니다.

## 2. 현재 방에 실제로 들어가는 것

생산 경로에서 `postMessage`를 호출하는 곳은 셋뿐입니다.

| 위치 | 메시지 |
|---|---|
| `packages/application/src/core-pipeline.ts:268` | `question` / `authorKind: "user"` — 사용자 요청 원문 |
| `packages/application/src/core-pipeline.ts:300` | `handoff` / `authorKind: "agent"` / `authorId: "representative"` — `replyTo`·`causedBy`로 요청에 연결, `executionId` 포함 |
| `packages/application/src/adapters/domain.ts:861` | 공개 command `collaboration.message.post` — Surface에서 사람이 보낼 때 |

방 자체는 `core-pipeline.ts:213 coreOfficeRoom()`이 Work마다 하나 보장합니다.

- 제목 `"Core Office"`, coordinator `representative`
- 참가자: 사용자 + `CORE_OFFICE_HANDLES` 8개
- 한계: `maxParallel: 8`, `maxRounds: 100`, `maxCostMicros: 1_000_000`, `maxTokens: tokenBudget`

**방을 더 만드는 생산 코드는 없습니다.** `collaboration.room.open`은 공개 command로 열려 있지만 호출하는 실행 경로가 없습니다.

## 3. 연결 지점 — 이미 있는 seam

새 배관을 깔 필요가 없습니다. 런타임이 이미 델타를 방출하고, application이 이미 그걸 관찰합니다.

```
packages/runtime/src/contracts.ts:53
  ExecutionDeltaKind = "output-text" | "reasoning" | "tool-call" | "tool-result" | "lifecycle" | "error"

packages/runtime/src/contracts.ts:55
  ExecutionDelta { executionId, agentHandle, sequence, kind, text?, toolName?, toolCallId?, summary?, occurredAt }

packages/runtime/src/contracts.ts:67
  ExecutionDeltaObserver.observe(context, delta)   // 동기 fire-and-forget

packages/runtime/src/voltagent-runner.ts:50   options.deltaObserver
packages/runtime/src/voltagent-runner.ts:1324  관찰자 호출 지점
packages/application/src/execution-stream.ts:17  ExecutionStreamRegistry implements ExecutionDeltaObserver
apps/server/src/product.ts:465  deltaObserver: executionStream  ← 주입 지점
```

**VoltAgent의 `delegate_task`는 `tool-call` / `tool-result` 델타로 흐릅니다.** `toolName`으로 식별할 수 있습니다.

권장 형태: `ExecutionDeltaObserver`를 구현하는 **협업 기록기**를 하나 더 만들고 `apps/server/src/product.ts:465`에서 기존 `executionStream`과 함께 주입합니다. `voltagent-runner`를 고치지 않아도 됩니다.

관찰자 계약이 **동기 fire-and-forget이고 예외·배압을 실행 경로에 전파하지 않는다**는 점에 유의하세요. 기록 실패가 에이전트 실행을 죽이면 안 됩니다. 큐에 넣고 비동기로 커밋하되, 실패는 삼키지 말고 로그와 이벤트로 남기십시오.

## 4. 무엇을 기록해야 하는가

`delegate_task` 한 번은 협업방에서 **두 메시지**입니다.

| VoltAgent 사건 | 협업 메시지 |
|---|---|
| supervisor가 subAgent에 위임 (`tool-call`) | `messageType: "handoff"` 또는 `"question"`, `authorId: <supervisor handle>` |
| subAgent 응답 (`tool-result`) | `messageType: "answer"`, `authorId: <subAgent handle>`, `replyToMessageId: <위 메시지>` |

지켜야 할 것:

- `authorId`는 **조직 handle**입니다. `agentHandle` 델타 필드가 그대로 정체성이며 화면의 이름·색이 여기서 파생됩니다.
- `replyToMessageId`·`causedByMessageId`를 반드시 채우십시오. 화면이 답변 들여쓰기와 반론 인용을 **이 값으로만** 그립니다. 없으면 대화가 평평해집니다.
- `tokenCount`·`costMicros`를 채우십시오. 방 예산 소비량은 방 레코드가 아니라 **메시지 합**으로 계산됩니다(`query-registry.ts` `work.rooms` 투영).
- `executionId`를 연결하십시오. 실행과 대화의 계보가 이어집니다.
- `commandId`는 idempotent해야 합니다. `core-pipeline.ts`가 `${runId}:core-office-request` 형식을 씁니다. 재시도·복구에서 중복 커밋이 나면 안 됩니다.
- 방의 `maxRounds`·`maxTokens`·`maxCostMicros`가 도메인에서 강제됩니다(`collaboration.test.ts` "참여자와 round·token·deadline 한계를 강제한다"). 한계 초과 시 도메인이 거부하므로 그 경로를 처리해야 합니다.

`challenge`·`change_request`·`review_request`·`decision`·`evidence`·`proposal`은 VoltAgent 기본 위임에서 자연히 나오지 않습니다. 에이전트 프롬프트·도구가 그런 발화를 만들게 되면 그때 매핑하십시오. **없는 것을 추측해서 만들지 마십시오.**

## 5. 프론트엔드는 이미 준비돼 있습니다

데스크톱은 이 데이터를 받을 준비가 끝났습니다. **연결만 되면 화면이 채워집니다.** 프론트엔드 수정은 필요 없습니다.

| 계층 | 상태 |
|---|---|
| 조회 계약 | `work.rooms` · `work.messages` · `work.shared-contexts`가 `ApplicationQueryMapV1`에 노출됨 |
| 계보 전달 | `replyToMessageId` · `causedByMessageId`가 read-model → 투영 → 계약까지 이어짐 |
| 예산 | `roundCount` · `maxRounds` · `usedTokens` · `usedCostMicros`가 메시지 합으로 계산돼 전달됨 |
| 화면 투영 | `apps/desktop/src/desktop-service.ts` `projectRoomActivities()` — 타입별 문법 분기 |
| 렌더 | `apps/desktop/src/room.tsx` — 인용 반론, 들여쓴 답변, 화자 전환선, 제안 블록 |
| 정체성 | `packages/application/src/design-tokens.ts` `agentIdentityToken(handle)` — handle에서 이름·색 파생 |

투영이 기대하는 것과 실제 데이터가 어긋나면 `apps/desktop/src/room-projection.test.ts`가 잡습니다.

**현재 fixture는 완성본 기준으로 그려져 있습니다.** 실제 런타임이 만들지 않는 대화가 들어 있는데, 이는 프론트엔드가 도달할 목표 상태를 고정하기 위한 의도적인 선택입니다. 구현이 붙으면 fixture와 실제 데이터를 비교해 차이를 확인하십시오.

## 6. 복수 협업방

한 Work에 방이 여럿인 것은 **제품 의도에 포함됩니다.** 헌법 4.1과 아키텍처 7절이 *"직접 메시지나 다자 협업방"*을 함께 말합니다. 2인 방이 곧 직접 대화이며, 도메인에는 `kind` 구분이 없고 참가자 수만 다릅니다.

현재 상태:

- 도메인은 `CollaborationRoom.work_id`로 복수 방을 허용합니다.
- `collaboration.room.open`이 공개 command로 열려 있습니다.
- **생산 실행 경로에서 이를 호출하는 코드가 없습니다.** `core-pipeline.ts`가 `Core Office` 방 하나만 보장합니다.
- **데스크톱은 이미 복수 방을 지원합니다.** `loadRooms(workId)`가 모든 방을 읽고, 각 방의 참가자·예산·공유 컨텍스트를 따로 표시합니다.

### 화면이 방을 늘어놓는 방식

**모든 방을 탭으로 자동 추가하지 않습니다.** 에이전트가 주제별로 방을 파면 개수를 예측할 수 없고 탭 바가 감당하지 못합니다. 대신 슬랙 스레드에 가까운 구조를 씁니다.

- 대표 방(첫 방)이 기본이고, 방이 하나뿐이면 탭 바 자체를 그리지 않습니다.
- 하위 방은 **대표 방 타임라인 안에 인라인 참조 블록**으로 나타납니다. 참가자 아바타·이름·발언 수·마지막 줄·시각을 보여주므로 열지 않고도 무슨 얘기가 오갔는지 판단할 수 있습니다.
- 사용자가 그 블록을 누를 때만 탭이 열리고, ✕로 닫을 수 있습니다. 대표 방은 닫히지 않습니다.
- 그 방에 승인·제안이 있으면 인라인 블록과 탭 양쪽에 `◇`와 gate 배경이 붙습니다.

**인라인 참조의 위치는 그 방의 첫 발언 시각에서 파생합니다.** 도메인에 `parent_room_id`가 없으므로 부모-자식 관계를 만들어내지 않고, 시간 순 병합만 합니다.

구현 시 참고: `desktop-service.ts` `withRoomReferences()`가 이 병합을 하고 `room.tsx` `RoomReference`가 렌더합니다. 방이 20개가 돼도 타임라인이 20줄 길어질 뿐 UI가 무너지지 않습니다.

### 남은 것

**에이전트가 하위 주제로 방을 여는 실행 경로**입니다. 언제 새 방을 파야 하는지(주제 분기? 2인 직접 대화? 병렬 Task별?)는 제품 결정이 먼저 필요합니다. 결정되면 `collaboration.room.open`을 호출하고 그 방에도 4절의 메시지 기록 규칙을 그대로 적용하십시오.

방이 늘어나도 화면은 구현 전후로 깨지지 않습니다.

## 7. 조직 변경 제안 블록 — 계약이 통째로 없습니다

`proposal` 메시지에 붙는 조직 변경 블록은 **현재 100% fixture입니다.** 도메인에는 다 있고 계약이 하나도 노출하지 않습니다. 4·5절과 같은 패턴입니다.

| 화면이 그리는 것 | 도메인 (`packages/organization/src/organization.ts`) | 계약 |
|---|---|---|
| 이 업무에서만 / 조직에 남습니다 | `NodeScope` `:86` | `OrganizationNodeViewV1`에 `scope` 없음 |
| 실행 · 조율 · 총괄 역할 | `NodeRole` `:88` | 있음 (`contracts.ts:224`) |
| 노드 n개 · 참조 n건 | `ImpactReport` `:225` | 없음 |
| 조직 검사 통과 · 순환 없음 … | `ComplianceFinding.code` `:230`, `auditCompliance()` `:691` | 없음 |
| 조직 버전 n → n+1 · Revert 가능 | `RevertCommand` `:183` | 없음 |

조회 `work.organization-proposals`(payload `{ workId }`)를 추가하고 위 다섯을 실어 보내십시오.

**값은 도메인 열거값 그대로 보내십시오.** `auditCompliance()`는 위반을 반환하므로 통과 목록은 «전체 코드 − 위반 코드»입니다. 한글 문구는 화면이 소유합니다(`apps/desktop/src/room.tsx` `nodeRoleLabel`·`complianceLabel`·`scopeLabel`).

`apps/desktop/src/model.ts` `OrganizationChangeView`가 이 모양을 그대로 기다립니다. 투영 함수 하나면 연결됩니다.

### 7.1 조직 화면(구조 + 지도)도 같은 계약을 기다립니다

조직 표면(`OrganizationSurface`, `app.tsx`)은 구조(A) + 지도(B) 하이브리드로 완성돼 있지만 **실 데이터로는 못 굴러갑니다.** `organization.graph.snapshot`이 계층을 안 줍니다.

| 화면이 쓰는 것 | 실 경로 | 필요한 것 |
|---|---|---|
| 상하 관계 중첩, 지도 엣지 | `read-model.ts:365`가 **`parent_handle`을 SELECT 안 함** (`OrganizationNodeViewV1` 필드는 이미 있음) | SELECT와 read-model projection에 `parent_handle` 연결 |
| 임시/영속 분리, 점선 | `scope`는 읽지만 계약이 버림, `work_id` 없음 | `OrganizationNodeViewV1`에 `scope`·`work_id` 추가 |
| 부서·팀·팀장·구성원 구분 | `NodeRole`은 `orchestrator`·`coordinator`·`operator`뿐이며 조직 단위와 Agent를 구분하지 않음 | 조직 단위 종류와 Agent 소속을 도메인에서 분리해 조회 계약에 노출 |

**지도(B)의 승격 조건:** 지금 지도는 읽기 전용(방향 잡기·이동)입니다. ① `move`/`split`/`merge` command가 계약에 열리고 ② 위 `parent_handle`이 오면, 이 지도가 그대로 **드래그 편성 캔버스**가 됩니다(`@xyflow/react` 이미 설치됨, `OrgMap`의 `nodesDraggable`만 열면 됨). 그 전까지 편성은 화면에 없습니다.

## 8. 완료 판정

- [ ] `delegate_task` 한 번이 방에 `handoff`(또는 `question`) + `answer` 두 메시지로 남는다
- [ ] 두 메시지가 `replyToMessageId`로 이어지고 `executionId`가 실행에 연결된다
- [ ] `authorId`가 조직 handle이며 화면에서 이름·색이 올바르게 나온다
- [ ] `tokenCount`·`costMicros`가 채워져 방 예산 소비량이 증가한다
- [ ] 재시도·복구에서 중복 메시지가 생기지 않는다(idempotent `commandId`)
- [ ] 방 한계 초과가 실행을 죽이지 않고 정의된 상태로 끝난다
- [ ] 기록 실패가 에이전트 실행을 중단시키지 않는다
- [ ] 실제 Provider로 Work 하나를 완주해 방에 3건 이상의 메시지가 남는 증거를 `docs/evidence/phase-30/`에 남긴다

## 9. 범위 밖

- **Shared Context Reference·Resource Lease** — 도메인과 테스트는 있으나 생산 호출 0건. 공유 쓰기 충돌이 실제로 발생하는 시나리오가 나오면 그때 붙이십시오.
- **`System participant`** — 상태·정책 이벤트를 방에 남기는 경로.
