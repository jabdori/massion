# Core Runtime·Application·표면 계약 수렴 설계

> **상태:** 구현 기준 설계
> **목적:** fixture가 표현하는 완성본과 실제 도메인·Application·daemon 동작 사이의 누락을 한 번씩만 메웁니다.

## 1. 공통 원칙

1. 도메인 불변량은 화면이나 Application이 다시 판정하지 않습니다.
2. 등록돼 있으나 `unknown`인 조회·명령은 기존 반환 형태를 타입 지도에 올립니다.
3. 데스크톱의 `rows()`·`str()` 같은 임시 파서는 계약이 타입화되는 즉시 삭제합니다.
4. 화면용 한글 문구와 조직 이름 변환은 데스크톱이 소유합니다.
5. 승인·revision·command ID·correlation ID·인과 계보를 모든 변경 경로에서 보존합니다.
6. 새 범용 framework를 만들지 않고 기존 gateway·observer·service를 연결합니다.

## 2. 작업 A — 실제 Core Work 완주

### 목표

실제 데스크톱 요청 하나가 다음 정본을 순서대로 만듭니다.

```text
run.start
→ Work·Core Office room·사용자 question·Representative handoff
→ ContextVersion·Plan·Task
→ Runtime Execution·Artifact
→ Assurance Verification
→ Records
→ completed
```

### 연결 지점

- `apps/desktop/src/use-desktop-controller.ts`: 생성·선택·취소·재개와 durable event 반영
- `apps/desktop/src/desktop-service.ts`: 타입화된 query·command만 호출
- `packages/application/src/core-pipeline.ts`: intake와 단계 전이
- `packages/application/src/core-delivery-stage.ts`: workspace trust와 실행
- `packages/application/src/core-assurance-stage.ts`: 독립 검증과 완료 차단
- `packages/application/src/core-records-stage.ts`: 기록과 최종 완료
- `apps/server/src/product.ts`: 실제 service·runner 조립

### 완료 불변량

- 모델 없음·quota·네트워크 실패는 `failed`가 아니라 재시도 가능한 `blocked`입니다.
- `awaiting-approval`은 승인 전 `run.resume`으로 우회할 수 없습니다.
- 산출물 존재만으로 완료하지 않고 Assurance 통과와 Records 반영이 필요합니다.
- durable event를 놓치거나 앱을 다시 열어도 query 재조회로 복원합니다.

## 3. 작업 B — 실제 에이전트 협업 영속화

### 현재 막힘

`ExecutionDelta`의 `delegate_task` tool-call은 `toolName`과 `toolCallId`만 남기고 입력을 버립니다. 따라서 현재 핸드오프 문서의 “tool-call을 관찰해 수신 Agent를 안다”는 설명만으로는 구현할 수 없습니다. 목표 Agent를 추측하면 안 됩니다.

### 최소 델타 확장

```ts
export interface DelegationDeltaV1 {
  readonly targetAgentHandle: string;
  readonly objective: string;
}

export interface ExecutionDelta {
  // 기존 필드
  readonly delegation?: DelegationDeltaV1;
}
```

`delegation`은 `toolName === "delegate_task"`일 때만 존재합니다. Runtime adapter가 provider stream의 도구 입력을 검증해 조직 handle과 1,000자 이하 objective만 보존합니다. 임의 tool input, credential, 전체 prompt는 델타에 싣지 않습니다.

### 기록기

`packages/application/src/collaboration-delta-recorder.ts`에 `CollaborationDeltaRecorder`를 둡니다.

- 동기 `observe()`는 내부 Promise queue에 넣고 즉시 반환합니다.
- queue는 execution ID별 순서를 보존합니다.
- `tool-call`은 `handoff`, `tool-result`는 `answer`로 기록합니다.
- `toolCallId`로 원 handoff message ID를 찾습니다.
- command ID는 `${executionId}:delegate:${toolCallId}:request|answer`입니다.
- `replyToMessageId`와 `causedByMessageId`를 answer에 넣습니다.
- Work·Core Office room·supervisor handle은 Runtime execution/read model에서 조회합니다.
- 기록 실패는 실행에 전파하지 않고 운영 로그와 진단 사건을 남깁니다.
- daemon 종료 전 queue를 bounded flush합니다.

`apps/server/src/product.ts`에서는 새 observer abstraction을 만들지 않고 기존 `executionStream.observe()`와 `collaborationRecorder.observe()`를 순서대로 호출하는 작은 객체를 `VoltAgentRunner`에 주입합니다.

### 비용·토큰

현재 tool delta만으로 하위 Agent의 정확한 token·cost를 handoff 메시지에 배분할 근거가 없습니다. 첫 연결은 0으로 지어내지 않고 값이 없는 상태를 허용하도록 projection을 조정합니다. Provider usage가 Agent·toolCall 단위로 노출되는 실제 근거가 생기면 채웁니다. 방의 전체 실행 비용은 Runtime execution 집계와 별도로 표시합니다.

## 4. 작업 C — 조직 실데이터와 변경 제안

### 조회 타입

```ts
export interface OrganizationNodeViewV1 {
  readonly node_id: string;
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly parent_handle?: string;
  readonly status: "active" | "inactive" | "retired";
  readonly role: "orchestrator" | "coordinator" | "operator";
  readonly scope: "persistent" | "work";
  readonly work_id?: string;
  readonly capabilities: readonly string[];
}
```

`packages/application/src/adapters/read-model.ts`의 SELECT와 projection이 `parent_handle`·`scope`·`work_id`를 모두 보존합니다. 화면은 role을 부서·팀으로 번역하지 않습니다. 정확한 조직 단위 종류가 도메인에 생기기 전까지 총괄·조율·실행으로만 말합니다.

### 변경 명령

범용 `organization.command`를 유지하되 `ApplicationCommandMapV1`에 현재 `create`·`move`·`split`·`merge`·`revert`·`install-profile` union payload를 타입화합니다. 데스크톱 서비스는 raw `Record<string, unknown>` 대신 의도별 메서드를 제공합니다.

지도 drag는 직접 `move`를 보내지 않습니다.

```text
drag
→ 변경 미리보기
→ ImpactReport·ComplianceFinding·버전 변화 표시
→ 승인 필요 시 수신함
→ 승인 뒤 같은 command 계보 재개
→ snapshot 재조회
```

`work.organization-proposals` 조회는 제안 메시지와 다음 정보를 연결합니다: scope, 역할, 부모, 영향 노드·참조, compliance 위반, 현재/대상 조직 버전, revert 가능 여부. 홈 전역 집계를 위해 `organization.proposals`에 `status` 필터를 둡니다. 두 조회는 같은 projection을 재사용합니다.

## 5. 작업 D — 개선 계약

### 실제 기존 경로

- 등록 명령: `growth.configure`, `growth.adopt`, `growth.revert`
- 등록 조회: `growth.configuration.get`, `growth.memories`, `growth.suggestions`, `growth.effects`
- 도메인 gateway: `evaluate`, `captureEffectBaseline`, `observeEffect`도 존재
- 없는 것: 상세 근거 조회, 평가·명시적 거절·효과 관측 공개 명령, typed map, 데스크톱 연결

### 조회

```ts
interface GrowthSuggestionDetailViewV1 {
  readonly suggestionId: string;
  readonly workId: string;
  readonly targetKind: string;
  readonly operation: string;
  readonly summary: string;
  readonly rationale: string;
  readonly expectedEffect: string;
  readonly riskSummary: string;
  readonly status: string;
  readonly revision: number;
  readonly reflectionRunId: string;
  readonly sourceReferences: readonly {
    readonly kind: string;
    readonly id: string;
    readonly title: string;
  }[];
  readonly patch: unknown;
  readonly createdAt: string;
}
```

추가 operation:

- `growth.suggestion.get`
- `growth.evaluation.get`
- `growth.evaluation.signals`
- `growth.adoption.get`
- 확장된 `growth.effects`

### 명령

- `growth.suggestion.evaluate`: gateway `evaluate`
- `growth.suggestion.approve`: 기존 `growth.adopt`의 제품 별칭. 기존 operation은 호환을 위해 유지
- `growth.suggestion.reject`: suggestion 상태와 사유를 영속하는 작은 도메인 메서드 추가
- `growth.adoption.revert`: 기존 `growth.revert`의 제품 별칭
- `growth.effect.observe`: baseline과 observation을 명시적 payload로 구분

승인 가능 조건은 서버가 판정합니다. 데스크톱 `growthBlockers()`는 설명용이며 보안 경계가 아닙니다. 대상 checksum이 달라지면 conflict를 반환하고 상세을 다시 읽습니다.

### 공개 사건

- `growth.suggestion-created`
- `growth.suggestion-evaluated`
- `growth.suggestion-adopted`
- `growth.suggestion-rejected`
- `growth.effect-observed`
- `growth.adoption-reverted`

이 사건은 수신함과 개선 조회를 무효화합니다. 별도 polling loop를 만들지 않습니다.

## 6. 작업 E — 확장 Capability

### 설치 조회

```ts
export interface ExtensionInstallationViewV1 {
  // 기존 필드
  readonly contributions: readonly {
    readonly kind: ExtensionContributionKindV1;
    readonly ids: readonly string[];
  }[];
  readonly permissions: readonly {
    readonly kind: ExtensionPermissionKindV1;
    readonly values: readonly string[];
  }[];
}
```

값은 설치된 active version manifest에서 읽습니다. 한글 문구는 `app.tsx`의 기존 label 함수가 소유합니다.

Registry의 `search`·`info`·`inventory` 반환 타입을 `ApplicationQueryMapV1`에 등록하고 데스크톱 `marketplaceEntries()`의 구조 파싱을 제거합니다.

### 실제 Capability 사용

첫 세로 흐름은 공식 확장 하나의 `runtimeTools` 하나만 대상으로 합니다.

```text
Registry 검색
→ manifest Capability·권한 검토
→ 설치 승인
→ worker healthy
→ tool catalog에 선언된 도구 등록
→ Work 실행에서 tool 호출
→ approval·execution·audit 기록
→ 확장 화면에 healthy와 제공 Capability 표시
```

조직 Template·Skill·MCP를 한꺼번에 연결하지 않습니다. runtime tool 한 개의 실제 사용이 끝난 뒤 같은 broker seam으로 다음 contribution을 추가합니다.

## 7. 작업 F — 설정 계약과 로컬 상태

기존 일곱 조회를 실제 handle 반환 형태 그대로 타입화합니다.

- `router.catalog`
- `router.routes`
- `router.credentials`
- `subscription.providers`
- `subscription.accounts`
- `subscription.quota`
- `subscription.policy`

`router.credentials` 타입에는 label·kind·상태만 있고 secret 필드는 존재하지 않습니다. 타입화 뒤 `SettingsView`의 `unknown`과 `projectModelRoutes()`·`projectProviderConnections()`·`projectSubscriptionAccounts()`·범용 parsing helper를 삭제합니다.

새 `local.runtime.status` 조회는 다음 읽기 전용 값만 제공합니다.

```ts
interface LocalRuntimeStatusViewV1 {
  readonly daemonStatus: "ready" | "limited" | "stopping";
  readonly appVersion: string;
  readonly databaseVersion: string;
  readonly dataPath: string;
  readonly lastBackupAt?: string;
}
```

데이터 크기는 디렉터리 전체를 반복 순회해야 하므로 이번 범위에서 제외합니다. 실제 운영 판단에 필요하다는 사례가 생기면 daemon이 유지하는 metric으로 추가합니다.

## 8. 전역 수신함과 홈 집계

전역 `InboxItem`의 원천은 계속 App 하나입니다.

- pending approval
- blocked Work
- awaiting-review Growth suggestion
- pending Organization proposal가 계약 연결 뒤 추가

수신함은 탐색 표면이고 조직 전역 approval의 임시 예외를 제외하면 결정을 반복하지 않습니다. 사건을 받으면 영향받는 원천 query만 다시 읽고, 닫기·읽기는 해결 상태를 바꾸지 않습니다.

## 9. 자동 검사 상한

각 작업은 다음 최소 테스트만 새로 가집니다.

| 작업 | 필수 테스트 |
|---|---|
| Core | 실제 단계가 Assurance 없이 completed가 되지 않는 통합 테스트 1개 |
| 협업 | delegate request/answer 영속·멱등·기록 실패 격리 통합 테스트 1개 |
| 조직 | snapshot 필드 투영과 stale revision 거부 테스트 각 1개 |
| 개선 | 평가 없는 승인, checksum drift, 거절 기록을 한 표 기반 테스트로 묶음 |
| 확장 | 설치 manifest 선언 투영 + 실제 Tool 사용 제품 테스트 1개 |
| 설정 | 일곱 typed query와 secret 부재 계약 테스트 1개 |

그 밖의 실패는 실제 UAT에서 발견된 경우에만 회귀 테스트를 추가합니다.

## 10. 완료 판정

- [ ] 실제 데이터에서 fixture 전용 분기가 사용자 흐름에 나타나지 않는다
- [ ] 데스크톱 서비스의 `unknown` 파싱이 Registry·설정·개선 경로에서 제거된다
- [ ] 실제 agent delegation이 방에 인과 관계와 함께 남는다
- [ ] 조직 변경이 영향·승인·revision을 우회하지 않는다
- [ ] 개선 승인·거절·효과·되돌리기가 실제 명령을 실행한다
- [ ] 설치된 확장의 Capability가 Work에서 실제 사용된다
- [ ] Provider secret이 query·error·event·evidence에 존재하지 않는다

