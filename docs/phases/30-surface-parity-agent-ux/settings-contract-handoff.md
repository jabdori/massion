# 핸드오프 — 설정 조회를 계약에 등록하기

> **상태:** 미구현. 다른 에이전트가 이어받도록 작성한 인계 문서
> **작성일:** 2026-07-24
> **관련 갭:** [제품 헌법 6절·9.1](../../product/constitution.md)

## 1. 무엇이 없는가

설정 화면이 쓰는 조회 일곱은 **전부 등록돼 있고 실제 데이터를 돌려줍니다.** 없는 것은 `ApplicationQueryMapV1`의 항목입니다. 그래서 데스크톱이 `unknown`으로 받아 런타임 파싱을 합니다.

| 조회 | 등록 | 계약 타입 |
|---|---|---|
| `router.catalog` | `query-registry.ts:1339` | **없음** |
| `router.routes` | `:1319` | **없음** |
| `router.credentials` | `:1292` | **없음** |
| `subscription.providers` | `:1389` | **없음** |
| `subscription.accounts` | `:1397` | **없음** |
| `subscription.quota` | `:1439` | **없음** |
| `subscription.policy` | `:1455` | **없음** |

`SettingsView`(`apps/desktop/src/desktop-service.ts`)의 일곱 필드가 전부 `unknown`인 것이 이 사실의 그림자입니다.

## 2. 필요한 것

각 조회의 `handle`이 **이미 뷰 모양으로 매핑해서** 돌려줍니다(snake_case → camelCase까지). 그 모양을 그대로 인터페이스로 옮겨 `ApplicationQueryMapV1`에 등록하면 됩니다. 새 계산은 없습니다.

```ts
// contracts.ts — handle의 반환문을 그대로 타입으로 옮깁니다
export interface RouterCatalogViewV1 {
  readonly providers: readonly { providerId; displayName; adapterKind; enabled }[];
  readonly endpoints: readonly { endpointId; providerId; name; baseUrl; local; gatewayKind; enabled }[];
  readonly models: readonly { modelProfileId; providerId; endpointId; modelId; routeKind; equivalenceGroup; verified; enabled }[];
  readonly candidates: readonly { candidateId; routeId; modelProfileId; priority; enabled }[];
}
export interface ModelRouteViewV1 { routeId; name; routeKind; credentialPolicy; dataPolicy; equivalenceGroup; spentMicros; totalBudgetMicros; enabled }
export interface SubscriptionAccountViewV1 { accountId; providerId; alias; scope; canManage; status; billingKind; version; connectorId; cooldownUntil?; windows?; minimumRemainingRatio?; earliestResetAt?; quotaExhausted?; quotaObservedAt? }
```

`router.credentials`는 **자격 증명 값을 절대 싣지 않아야** 합니다. 지금도 싣지 않으며, 화면은 label과 종류만 씁니다. 계약에 올릴 때 이 경계를 타입으로 고정하십시오.

## 3. 로컬 운영 환경 — 조회 자체가 없음

헌법 6절은 설정이 *"로컬 운영 환경"*을 소유한다고 씁니다. **daemon 상태·데이터 위치·백업을 볼 조회가 없습니다.** 화면의 `로컬 환경` 구역은 지금 이 사실을 그대로 말합니다.

필요한 것(제품 결정이 먼저): daemon 실행 상태·버전, SurrealDB 데이터 경로와 크기, 마지막 백업 시각.

## 4. 프론트엔드 상태

**연결만 되면 파싱이 사라집니다.**

| 계층 | 위치 |
|---|---|
| 뷰 타입 | `desktop-service.ts` `ModelRouteView`·`ProviderConnectionView`·`SubscriptionAccountView` |
| 투영 | 같은 파일 `projectModelRoutes()`·`projectProviderConnections()`·`projectSubscriptionAccounts()` |
| 문구 | `app.tsx` `routeKindLabel`·`billingKindLabel`·`quotaText` |

투영 셋은 계약이 타입을 주면 **삭제 대상**입니다. 남는 것은 문구 표뿐이고, 그건 화면이 소유하는 게 맞습니다.

## 5. 완료 판정

- [ ] 일곱 조회가 `ApplicationQueryMapV1`에 타입과 함께 등록된다
- [ ] `desktop-service.ts`의 `project*` 셋과 `rows()`/`str()`/`num()`/`bool()` 헬퍼가 삭제된다
- [ ] `SettingsView`의 `unknown` 일곱이 사라진다
- [ ] `router.credentials`가 secret을 싣지 않음이 타입으로 보장된다

---

# 부록 A. 업무 표면 — Records(기록)

Work 상세에 `기록` 탭을 세우고 완료된 Work 픽스처(`refund-delay`)를 넣으면서 확인한 경계입니다.
탭이 그리는 값은 전부 `WorkRecord`(`packages/work/src/work.ts` `:542`)와 `RecordsDocument`
(`packages/records/src/contracts.ts` `:47`)에 실재합니다. 아래는 **도메인에 없어서 화면이 앞세운 것**입니다.

| 화면이 앞세운 것 | 위치 | 도메인 현황 | 필요한 것 |
|---|---|---|---|
| `work.records` 결과를 실제로 싣기 | `desktop-service.ts` `projectWorkDetail()`·`projectWorkSummary()` — 둘 다 `records: []` | `work.records` 조회는 `query-registry.ts` `:1150`에 **있으나** client 계약(`ApplicationQueryMapV1`)에 없음 | `WorkRecordViewV1` 등록. `handle`이 이미 `recordId·version·summary·artifactIds·verificationIds·finalizedAt`로 돌려줌 |
| `recordedRevision`·`finalizedBy`·`snapshotHash`·`eventRange`·`decisionIds`·`documents` | `model.ts` `RecordView` | 테이블 `work_record`에 `recorded_work_revision`·`finalized_by`·`records_snapshot_hash`·`event_start_sequence`/`event_end_sequence`·`decision_message_ids`·`document_ids` **전부 있음** | `work.records`의 `handle` 반환에 이 여섯을 추가. 새 계산 없음 |
| 문서의 `kind`·`checksum` | `model.ts` `RecordDocumentView` | `records_document`에 `kind`·`markdown_checksum` 있음. **Work 조회 경로에는 노출되지 않음** | `work.records`가 `document_ids`를 문서 요약으로 풀거나 `records.documents` 조회 신설 |
| 결정 본문 | `app.tsx` `InspectorRecords()` — `decisionIds`를 `work.activities`의 `decision` 메시지에서 해소 | `decision_message_ids`는 **ID만** 보존. 본문은 `collaboration_message` | 지금 방식(활동 흐름에서 해소)이 맞음. 계약 변경 불필요 |
| 승인 이력 | `app.tsx` `InspectorRecords()` — `work.approvals`를 별도 구역으로 | `WorkRecord`에 **승인 참조가 없음**. 기록이 아니라 Work가 지나온 승인 | 기록이 승인을 보존해야 한다면 `work_record`에 approval 참조 필드가 먼저 필요 |
| 최종 응답 표시(`final`) | `model.ts` `ActivityView.room.final`, `room.tsx` `RoomMessage` | `collaboration_message`에 **최종 응답 표식이 없음**. 대표 에이전트의 책임으로만 존재(`packages/organization/src/organization.ts` `:23`, 헌법 §5) | Records 완료 시점의 Representative `answer`를 도메인이 표시하거나, 화면이 「Work 완료 + 마지막 `answer` + 수신자=사용자」로 계속 파생 |

## 완료 판정

- [ ] `work.records`가 `ApplicationQueryMapV1`에 타입과 함께 등록된다
- [ ] `projectWorkDetail()`의 `records: []`가 실제 투영으로 바뀐다
- [ ] `RecordView`의 여섯 필드가 계약에서 온다
- [ ] 최종 응답이 화면 파생이 아니라 도메인 사실로 읽힌다
