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

## 6. 인풋(Composer)이 앞세운 세 가지

인풋은 「이 요청이 어떤 조건으로 나가는가」를 보내기 전에 말합니다. 셋 다 도메인이 아직 돌려주지 않아
화면 상태로 서 있습니다. 위치는 `app.tsx`의 `WorkActivity` — `modelOverride`·`effortOverride`·`queuedOverride`.

| 화면이 세운 것 | 뷰 타입 | 필요한 계약 |
|---|---|---|
| Work별 모델 선택 | `WorkView.modelId` | Work 단위 모델 배치를 읽고 쓰는 명령. 지금은 조직이 배치한 결과만 활동 로그에서 «읽습니다» |
| 추론 수준 | `WorkView.reasoningEffort` | 도메인에 개념 자체가 없습니다. `router` 스키마에 `reasoning_effort` 축이 서야 합니다 |
| 대기 중인 지시 | `WorkView.queuedDirectives` | `work.directives`가 미반영 지시를 돌려줘야 합니다. 지금은 제출 성공만 알고 큐를 못 봅니다 |

「현재 작업 조정」은 대기 카드의 내용을 `submitDirective(work, content, "now")`로 다시 보냅니다.
`DirectiveMode`는 실제 계약이라 그대로 씁니다 — 바뀐 것은 **고르는 시점**뿐입니다(보내기 전 → 보낸 후).

### 완료 판정 (추가)

- [ ] `work` 조회가 미반영 지시 목록을 돌려준다
- [ ] Work 단위 모델·추론 수준을 읽고 쓰는 명령이 등록된다
- [ ] `WorkActivity`의 세 `*Override` 상태가 삭제된다

## 7. 설정 표면 정리에서 드러난 것

### route_kind 어휘가 둘입니다 — 확인 필요

| 출처 | 값 |
|---|---|
| `packages/router/src/model-router.ts` `RouteKind` | `"chat" \| "embedding"` |
| 픽스처 카탈로그·`model_profile.route_kind` 데이터 | `"reasoning" \| "utility" \| "embedding"` |

화면은 어느 쪽도 박지 않고 **카탈로그에 실제로 있는 값**에서 고르게 했습니다(`routeKinds`).
어느 쪽이 정본인지 정해야 합니다. 전에는 폼이 `"chat"`을 하드코딩해서, 손으로 등록한 모델이
세 라우트 중 어디에도 붙지 않았습니다.

### 사람이 「검증됨」을 주장할 수 없게 했습니다

`router.model.register`에 `verified: false`를 고정합니다. 검증은 `model_verification_evidence`가
정하는 것이지 등록자가 체크박스로 선언할 값이 아닙니다. 전에는 체크하면 프로바이더 표면의
「미확인」 표시가 근거 없이 사라졌습니다.

### 후보 우선순위가 화면에 없었습니다

`addRouteCandidate`는 `priority`를 받는데 입력이 없어 늘 `0`으로 나갔습니다. fallback 순서가
정해지지 않는다는 뜻입니다. 입력을 세웠습니다.

### 자가개선 채택 모드를 쓰는 명령이 없습니다

읽기(`AutonomyView.growthMode`)만 있고 쓰기가 없어 화면 상태(`growthModeOverride`)로 서 있습니다.
전체 권한일 때 `auto`로 파생되는 규칙은 `effectiveGrowthMode()`가 이미 갖고 있습니다.

- [ ] `route_kind` 정본 어휘를 정한다
- [ ] 자가개선 채택 모드를 쓰는 명령이 등록된다
