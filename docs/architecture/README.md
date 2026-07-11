# Massion AgentOS 1.0 전체 아키텍처

> **문서 상태**: 현재 구현 아키텍처 정본
> **기준일**: 2026-07-11
> **제품 구현 기준 커밋**: `131b1b3`
> **제품 정본**: [Massion 완제품 설계 명세](../product/2026-07-10-complete-product-design.md)
> **진행 정본**: [Massion AgentOS 1.0 프로그램 계획](../superpowers/plans/2026-07-10-massion-agentos-1.0-program.md)

이 문서는 Massion을 처음 접하는 사람과 구현 에이전트가 제품 전체를 빠르게 파악하도록 돕습니다. 승인된 1.0 목표와 현재 코드를 같은 그림에 표시하되 상태를 명확히 구분합니다. 세부 계약은 각 Phase의 설계·구현 계획·회고와 실제 코드가 소유하며, 이 문서는 그 관계를 연결하는 지도입니다.

근거는 제품 정본, 완료된 Phase 회고와 실제 코드·테스트, 구현 중인 Phase 설계와 현재 코드, ADR·검증 자료 순으로 판정합니다. 대체된 과거 개념도는 현재 구조의 근거로 사용하지 않습니다.

## 1. 읽는 법과 상태 범례

| 시각 표현 | 상태 | 의미 |
|---|---|---|
| 녹색 실선·`구현됨` | 구현됨 | 완료된 Phase의 코드·테스트·회고 근거가 있음 |
| 파란색 굵은 실선·`구현 중` | 구현 중 | 코드가 존재하지만 현재 Phase 완료 검증 전 |
| 회색 점선·`예정` | 예정 | 승인된 1.0 범위이나 아직 구현되지 않음 |
| 주황색 이중선·`외부` | 외부 시스템 | Massion이 소유하지 않는 서비스·저장소 |

굵은 화살표는 사용자 Work의 주 실행 경로, 일반 실선은 동기 명령·직접 호출, 점선은 이벤트·관찰·정책 영향을 뜻합니다. 원통은 영속 저장소, 큰 경계 상자는 프로세스 또는 배포 단위입니다. 색상을 볼 수 없는 환경에서도 상태 라벨과 선 모양으로 구분할 수 있습니다.

기준 커밋에서 Phase 0~17은 구현됨, Phase 18~23은 예정입니다. 개별 요소는 Phase 번호만으로 판정하지 않고 실제 코드와 검증 결과를 함께 확인합니다.

## 2. 전체 시스템 지도

Massion은 사용자 요청을 일회성 채팅이 아닌 영속 업무(Work)로 만들고, 조직이 계획·조사·실행·검증·기록·개선을 분담하는 AgentOS입니다. CLI·TUI·Web·외부 Surface는 같은 Application API와 상태를 사용합니다.

```mermaid
flowchart TB
  classDef implemented fill:#dcfce7,stroke:#166534,color:#14532d,stroke-width:2px;
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  classDef planned fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-width:1px,stroke-dasharray:5 5;
  classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12,stroke-width:2px;

  Person["개인 사용자<br/>한 명의 개인 조직"]:::implemented
  Team["팀 사용자<br/>공유 조직과 역할"]:::implemented

  subgraph Surfaces["사용자 화면·외부 연동"]
    CLI["CLI · mass<br/>구현됨 · Phase 16"]:::implemented
    TUI["TUI · OpenTUI<br/>구현됨 · Phase 17"]:::implemented
    Web["Web Console<br/>예정 · Phase 18"]:::planned
    Channels["Slack · Discord · GitHub<br/>예정 · Phase 19"]:::planned
  end

  API["Application API<br/>인증 · 명령 · 조회 · SSE<br/>구현됨 · Phase 16"]:::implemented
  Coordinator["핵심 업무 조정기<br/>(CoreWorkCoordinator)<br/>구현됨 · Phase 16"]:::implemented

  subgraph AgentOS["Massion AgentOS Core"]
    Office["Core Office<br/>조직·업무 조정<br/>구현됨"]:::implemented
    Work["Work · Task · Collaboration<br/>구현됨"]:::implemented
    Governance["정책·선택적 승인<br/>Governance · 구현됨"]:::implemented
    Intelligence["맥락 · 근거 · 실행 · 검증<br/>기록 · 성장 · 구현됨"]:::implemented
    Runtime["에이전트 실행 계층<br/>VoltAgent Adapter · 구현됨"]:::implemented
    Router["모델·계정 라우터<br/>회전 · fallback · 구현됨"]:::implemented
    ExtHost["Extension Host<br/>격리 worker · 구현됨"]:::implemented
  end

  DB[("SurrealDB<br/>AgentOS 단일 정본<br/>구현됨")]:::implemented
  Registry["Massion npm 호환 Registry<br/>예정 · Phase 20"]:::planned
  Providers["LLM · Embedding Provider<br/>외부"]:::external
  Git["사용자 Git 저장소·원격<br/>외부"]:::external

  Person ==> CLI
  Team ==> CLI
  Person --> TUI
  Team -.-> Web
  Team -.-> Channels
  CLI ==> API
  TUI --> API
  Web -.-> API
  Channels -.-> API
  API ==> Coordinator
  Coordinator ==> Office
  Office --> Work
  Governance -. "정책·승인" .-> Coordinator
  Office --> Intelligence
  Intelligence --> Runtime
  Runtime --> Router
  ExtHost --> Runtime
  AgentOS --> DB
  Router --> Providers
  ExtHost -. "설치·업데이트" .-> Registry
  Intelligence --> Git
```

| 요소 | 상태 | 실제 위치 | 근거 |
|---|---|---|---|
| CLI·Application API | 구현됨 | `apps/cli`, `packages/application` | [Phase 16 회고](../phases/16-application-api-cli/review.md) |
| TUI | 구현됨 | `apps/tui` | [Phase 17 회고](../phases/17-tui/review.md) |
| Core Office·Work·Governance | 구현됨 | `packages/organization`, `packages/work`, `packages/governance` | [Phase 4 회고](../phases/04-organization-graph-core-office/review.md), [Phase 5 회고](../phases/05-work-collaboration-records/review.md), [Phase 8 회고](../phases/08-governance-approval/review.md) |
| Runtime·Router | 구현됨 | `packages/runtime`, `packages/router` | [Phase 6 회고](../phases/06-provider-credential-router/review.md), [Phase 7 회고](../phases/07-voltagent-runtime-adapter/review.md) |
| Extension Host | 구현됨 | `packages/extension-host` | [Phase 15 회고](../phases/15-extension-sdk-host/review.md) |
| Web·외부 Surface·Registry | 예정 | `docs/superpowers/plans/2026-07-10-massion-agentos-1.0-program.md` | 프로그램 Phase 18~20 |
| SurrealDB 단일 정본 | 구현됨 | `packages/storage` | [Phase 2 회고](../phases/02-surrealdb-source-of-truth/review.md) |

## 3. 제품 구성요소와 패키지 경계

각 패키지는 자신이 소유한 도메인 불변량을 검사합니다. Application 계층은 공개 서비스를 조합하지만 Work revision, tenant 격리, 정책, 승인, 증거 계보를 대신 판정하지 않습니다. VoltAgent는 실행 메커니즘이며 Massion의 공개 계약으로 노출되지 않습니다.

```mermaid
flowchart LR
  classDef implemented fill:#dcfce7,stroke:#166534,color:#14532d,stroke-width:2px;
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  classDef planned fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-width:1px,stroke-dasharray:5 5;
  classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12,stroke-width:2px;

  Foundation["기반 계약<br/>@massion/foundation"]:::implemented
  Storage["저장소 facade<br/>@massion/storage"]:::implemented
  Identity["사용자·tenant<br/>@massion/identity"]:::implemented
  Organization["조직 그래프<br/>@massion/organization"]:::implemented
  Work["업무·협업<br/>@massion/work"]:::implemented
  Governance["정책·승인<br/>@massion/governance"]:::implemented
  Router["모델·credential<br/>@massion/router"]:::implemented
  Runtime["실행 adapter<br/>@massion/runtime"]:::implemented

  subgraph Intelligence["지능·전문 실행 계층"]
    Context["맥락·전략<br/>@massion/context-strategy"]:::implemented
    Evidence["근거·조사<br/>@massion/evidence"]:::implemented
    Engineering["개발 실행<br/>@massion/software-engineering"]:::implemented
    Assurance["독립 검증<br/>@massion/assurance"]:::implemented
    Records["기록·문서<br/>@massion/records"]:::implemented
    Growth["회고·개선<br/>@massion/growth"]:::implemented
  end

  ExtSDK["Extension 계약<br/>@massion/extension-sdk"]:::implemented
  ExtHost["Extension 격리·broker<br/>@massion/extension-host"]:::implemented
  Application["제품 API 조합<br/>@massion/application<br/>구현 중"]:::implementing
  Surfaces["CLI · TUI · Web · Integration"]:::implementing
  VoltAgent["VoltAgent 실행 엔진<br/>외부"]:::external
  Provider["AI Provider<br/>외부"]:::external

  Foundation --> Storage
  Storage --> Identity
  Identity --> Organization
  Identity --> Work
  Organization --> Work
  Governance --> Work
  Router --> Runtime
  Organization --> Runtime
  Work --> Context
  Runtime --> Context
  Work --> Evidence
  Evidence --> Engineering
  Work --> Engineering
  Runtime --> Assurance
  Work --> Assurance
  Assurance --> Records
  Work --> Records
  Work --> Growth
  Runtime --> Growth
  ExtSDK --> ExtHost
  ExtHost --> Runtime
  ExtHost -. "capability broker만 허용" .-> Work
  Runtime --> VoltAgent
  Router --> Provider
  Identity --> Application
  Organization --> Application
  Work --> Application
  Governance --> Application
  Runtime --> Application
  Router --> Application
  Intelligence --> Application
  ExtHost --> Application
  Application --> Surfaces
```

| 경계 | 규칙 | 실제 위치 |
|---|---|---|
| 데이터 | SurrealDB SDK 타입은 저장소 facade 위 도메인 계약에 노출하지 않음 | `packages/storage` |
| 실행 | VoltAgent 타입은 Runtime adapter 내부에 격리 | `packages/runtime` |
| 제품 API | 도메인 공개 서비스만 조합하고 raw store를 반환하지 않음 | `packages/application` |
| Extension | worker는 capability broker만 사용하고 Database·credential에 직접 접근하지 않음 | `packages/extension-sdk`, `packages/extension-host` |

## 4. Core Office와 전문 조직

Core Office는 설치와 함께 모든 tenant 조직에 생성되는 제거 불가능한 여덟 개 내장 노드입니다. 조직 노드는 영속하지만 LLM 프로세스가 항상 실행되는 것은 아니며, Work가 필요로 할 때 Agent로 materialize됩니다. Software Engineering은 기본 배포판에 포함되지만 비내장(non-builtin) 전문 조직이고, Extension 조직은 설치·권한 부여 후에만 추가됩니다.

```mermaid
flowchart TB
  classDef implemented fill:#dcfce7,stroke:#166534,color:#14532d,stroke-width:2px;
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  classDef planned fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-width:1px,stroke-dasharray:5 5;
  classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12,stroke-width:2px;

  subgraph Core["Core Office · builtin · 제거·비활성화 불가"]
    Rep["Representative<br/>요청 접수·전체 조정·최종 응답"]:::implemented
    Strategy["Context & Strategy<br/>맥락·계획·위험·완료 기준"]:::implemented
    Evidence["Evidence & Research<br/>코드·문서·외부 근거"]:::implemented
    Gov["Governance<br/>정책·선택적 승인"]:::implemented
    Delivery["Delivery Coordination<br/>Task 배정·전문 실행 조정"]:::implemented
    Assurance["Assurance<br/>독립 검증·완료 차단"]:::implemented
    Records["Records & Documentation<br/>계보·ADR·변경·운영 기록"]:::implemented
    Growth["Growth<br/>회고·개선 평가·채택·되돌리기"]:::implemented

    Rep --> Strategy
    Rep --> Evidence
    Rep --> Gov
    Rep --> Delivery
    Rep --> Assurance
    Rep --> Records
    Rep --> Growth
  end

  subgraph Engineering["Software Engineering · 기본 전문 조직 · non-builtin"]
    EngTeam["software-engineering<br/>팀 coordinator"]:::implemented
    Lead["Engineering Lead<br/>분해·충돌·통합"]:::implemented
    Specialists["Frontend · Backend · Database<br/>Infrastructure specialists"]:::implemented
    Quality["Test Engineer · Security Reviewer<br/>Release Engineer"]:::implemented
    EngTeam --> Lead
    Lead --> Specialists
    Lead --> Quality
  end

  subgraph Extensions["설치형 전문 조직·Agent"]
    ExtOrg["Extension 선언 조직<br/>권한·호환성 검증 후 활성"]:::implemented
    ExtAgent["격리 worker의 Agent·Tool<br/>capability broker 사용"]:::implemented
    ExtOrg --> ExtAgent
  end

  Delivery --> EngTeam
  EngTeam -. "코드 근거" .-> Evidence
  Quality -. "독립 완료 판정은 위임하지 않음" .-> Assurance
  EngTeam -. "결정·산출물" .-> Records
  Rep -. "승인된 capability 범위에서 조정" .-> ExtOrg
```

| 조직 유형 | 변경 가능성 | 실행 방식 | 실제 위치 |
|---|---|---|---|
| Core Office 8개 | 제품 migration 외 변경 불가 | Work에 필요할 때 Agent materialize | `packages/organization`, `packages/runtime` |
| Software Engineering 9개 역할 | 조직 명령으로 비활성화 가능, 기본 배포 bootstrap은 활성 요구 | 격리 Git workspace와 TDD delivery | `packages/software-engineering` |
| Extension 조직·Agent | manifest·정책·승인·호환성 범위에서 설치·업데이트·rollback | Core 밖 격리 worker | `packages/extension-sdk`, `packages/extension-host` |

## 5. Work 처리 전체 흐름

대화가 아니라 Work와 불변 사건이 실행·복구의 정본입니다. 개발 작업과 비개발 작업은 Delivery에서 전문 실행 경로가 달라질 수 있지만, 어느 경로도 독립 Assurance와 Records를 생략해 완료할 수 없습니다.

```mermaid
flowchart LR
  classDef implemented fill:#dcfce7,stroke:#166534,color:#14532d,stroke-width:2px;
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  classDef planned fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-width:1px,stroke-dasharray:5 5;
  classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12,stroke-width:2px;

  Request["사용자 요청<br/>Request"]:::implemented
  Intake["대표 조직 접수<br/>Work 생성"]:::implementing
  Context["맥락·전략<br/>ContextVersion · Plan · Criteria"]:::implemented
  Evidence["근거 조사<br/>EvidenceBrief · source revision"]:::implemented
  Delivery{"실행 종류<br/>Delivery Coordination"}:::implemented
  Software["개발 작업<br/>Software Engineering<br/>TDD · Git provenance"]:::implemented
  Domain["비개발 작업<br/>전문 Agent·Tool 또는<br/>Representative 조정 실행"]:::implemented
  Approval{"정책상 승인이<br/>필요한가?"}:::implemented
  Auto["자동 실행<br/>auto 정책"]:::implemented
  Review["사람·조직 승인 대기<br/>review 정책"]:::implemented
  Runtime["Runtime Execution<br/>Task · Assignment · Artifact"]:::implemented
  Verify["독립 검증<br/>Assurance · Verification"]:::implemented
  Records["기록·문서 반영<br/>WorkRecord · ADR · Changelog · Runbook"]:::implemented
  Complete["검증된 Work 완료<br/>completed"]:::implemented
  Growth["회고·개선<br/>Suggestion · Evaluation · Adoption · Revert"]:::implemented

  Request ==> Intake
  Intake ==> Context
  Context ==> Evidence
  Evidence ==> Delivery
  Delivery -->|개발 criterion·Task| Software
  Delivery -->|그 밖의 전문 실행| Domain
  Software --> Approval
  Domain --> Approval
  Approval -->|아니오·auto| Auto
  Approval -->|예·review| Review
  Review -->|승인| Runtime
  Review -.->|거부·취소| Delivery
  Auto --> Runtime
  Runtime ==> Verify
  Verify -->|통과| Records
  Verify -.->|실패·차단·재계획| Delivery
  Records ==> Complete
  Complete ==> Growth
  Growth -. "승인된 개선만 새 버전 적용" .-> Context
```

| 단계 | 주요 정본 | 책임 패키지 |
|---|---|---|
| 접수·업무 | Request, Work, WorkEvent | `packages/work`, `packages/application` |
| 맥락·전략 | ContextVersion, StrategyGeneration, PlanVersion | `packages/context-strategy`, `packages/work` |
| 근거 | RepositoryRevision, IndexVersion, EvidenceBrief | `packages/evidence` |
| 실행 | RuntimeExecution, EngineeringDelivery, ArtifactVersion | `packages/runtime`, `packages/software-engineering`, `packages/work` |
| 검증 | AssuranceRun, criterion·check evidence, Verification | `packages/assurance`, `packages/work` |
| 기록·개선 | RecordsRun, WorkRecord, Growth Suggestion·Effect | `packages/records`, `packages/growth` |

## 6. 실행·승인·차단·취소·복구

핵심 업무 조정기 실행(Application run)은 현재 단계와 실행 임대 세대(lease generation)를 저장합니다. 자동 정책은 사람을 기다리지 않고 진행하고, review 정책만 `awaiting-approval`에서 정지합니다. 모델 부재는 성공이나 일반 실패로 꾸미지 않고 재시도 가능한 `blocked` 상태로 보존합니다.

```mermaid
stateDiagram-v2
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  [*] --> Ready: Work run 시작\nstage=intake
  Ready --> Running: runner claim\nlease generation +1
  Running --> Ready: 단계 결과 commit\n다음 stage 저장
  Running --> AwaitingApproval: review 정책\nsuspend + approval ID
  AwaitingApproval --> Running: 승인 결과 확인\n새 lease claim
  AwaitingApproval --> Cancelled: 거부 또는 사용자 취소\nactive 실행 drain
  Running --> Blocked: 모델·Provider 후보 없음\nmodel-unavailable
  Blocked --> Running: credential·route 복구 후\n명시적 retry
  Running --> Running: process crash + lease 만료\n새 generation 회수
  Running --> Running: domain commit 뒤 run update 장애\n동일 child command replay
  Running --> Completed: records stage 완료\nterminal result 고정
  Running --> Failed: 복구 불가능한 도메인 오류
  Ready --> Cancelled: 사용자 취소
  Running --> Cancelled: 신규 stage 차단\nRuntime·Delivery drain
  Completed --> [*]
  Failed --> [*]
  Cancelled --> [*]

  state Ready {
    [*] --> PendingStage
  }
  state Running {
    [*] --> DeterministicCommand
    DeterministicCommand --> DomainTransaction
  }
  class Ready,Running,AwaitingApproval,Blocked,Completed,Failed,Cancelled implementing
```

| 상황 | 저장되는 상태 | 복구 원칙 |
|---|---|---|
| 단계 실행 중 process crash | running + lease expiry | 만료 뒤 한 runner만 더 높은 generation으로 회수 |
| 도메인 commit 뒤 run 갱신 실패 | running + 이전 stage | `${runId}:${stage}` command를 replay하고 중복 side effect 차단 |
| 선택적 승인 필요 | awaiting-approval + approval ID | Governance의 영속 결정을 확인한 뒤 재개 |
| 모든 모델 경로 사용 불가 | blocked + reason | credential·route 복구 후 명시적 retry |
| 사용자 취소 | cancelled | 새 stage를 막고 활성 Runtime·Delivery를 먼저 drain |

## 7. 에이전트 협업과 대화

Organization Graph의 활성 노드는 tenant별 Agent map으로 투영됩니다. Agent는 상대를 발견해 직접 메시지나 다자 협업방에서 대화할 수 있고 독립 Task는 병렬 실행할 수 있지만, 메시지·위임·공유 맥락·실행·사용자 개입은 모두 하나의 Work와 인과 계보에 귀속됩니다.

```mermaid
flowchart TB
  classDef implemented fill:#dcfce7,stroke:#166534,color:#14532d,stroke-width:2px;
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  classDef planned fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-width:1px,stroke-dasharray:5 5;
  classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12,stroke-width:2px;

  Org["Organization Graph<br/>활성 node · 관계 · capability"]:::implemented
  Map["Tenant Agent Map<br/>Agent · Supervisor · Subagent<br/>직접 주소·위임 도구"]:::implemented
  Observer["사용자 Surface<br/>관찰 · 메시지 · 승인 · 취소"]:::implementing

  subgraph WorkBoundary["하나의 Work에 귀속된 협업 경계"]
    Room["Collaboration Room<br/>동시 실행·시간·token·cost·round 제한"]:::implemented
    User["사용자 participant"]:::implemented
    AgentA["Agent A<br/>Task·Assignment·Session"]:::implemented
    AgentB["Agent B<br/>Task·Assignment·Session"]:::implemented
    AgentC["Agent C<br/>Task·Assignment·Session"]:::implemented
    System["System participant<br/>상태·정책 event"]:::implemented
    Messages["순서화된 메시지<br/>reply · caused-by · handoff"]:::implemented
    Shared["Shared Context Reference<br/>불변 읽기 snapshot"]:::implemented
    Lease["Resource Lease<br/>공유 쓰기·expected revision"]:::implemented
    Events["Work · Runtime · Collaboration events<br/>correlation · causation"]:::implemented

    User --> Room
    AgentA --> Room
    AgentB --> Room
    AgentC --> Room
    System --> Room
    Room --> Messages
    AgentA <-->|"직접 질문·답변"| AgentB
    AgentA -. "병렬 Task" .-> AgentC
    AgentB -. "delegate_task · handoff" .-> AgentC
    Messages --> Shared
    Messages --> Lease
    Messages --> Events
  end

  Org --> Map
  Map --> AgentA
  Map --> AgentB
  Map --> AgentC
  Observer --> User
  Events -. "Application public event stream" .-> Observer
  Observer -. "정책 범위 내 개입" .-> Room
```

| 협업 요소 | 보장 | 실제 위치 |
|---|---|---|
| Agent map·위임 | 조직 버전에 맞는 활성 topology, 제거된 관계·Agent 반영 | `packages/runtime`, `packages/organization` |
| 직접·다자 대화 | 작성자, room sequence, reply·causation, 참조 계보 | `packages/work` |
| 병렬 실행 | 독립 Task, Assignment, Agent별 Session과 실행 제한 | `packages/work`, `packages/runtime` |
| 공유 상태 | 불변 SharedContextReference와 versioned resource lease | `packages/work` |
| 사용자 관찰·개입 | 공개 event, 승인·취소·메시지가 같은 Work에 기록 | `packages/application`, `packages/governance` |

## 8. 모델 계정·Provider 라우팅

Agent와 도메인은 실제 모델·계정을 직접 선택하지 않고 논리 모델 경로(Model Route)를 요청합니다. Router는 필수 capability, 데이터 정책, 예산, equivalence group과 평가 점수를 먼저 적용한 뒤 credential 정책으로 계정을 선택합니다. 지원 대상은 Provider가 자동화를 허용한 공식 API key, service account, workload identity와 OAuth이며 소비자 구독의 비공식 cookie·token 자동화는 포함하지 않습니다.

```mermaid
flowchart LR
  classDef implemented fill:#dcfce7,stroke:#166534,color:#14532d,stroke-width:2px;
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  classDef planned fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-width:1px,stroke-dasharray:5 5;
  classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12,stroke-width:2px;

  Request["논리 모델 요청<br/>chat 또는 embedding<br/>capability · data policy · budget"]:::implemented
  Route["Model Route<br/>순서 있는 candidate·equivalence"]:::implemented
  Filter["후보 필터<br/>capability · local-private · eval · cost"]:::implemented
  Pool["Provider Credential Pool<br/>active · cooldown · disabled · revoked"]:::implemented
  Policy{"계정 선택 정책<br/>priority · fill-first · round-robin<br/>weighted · least-used · quota-headroom<br/>reset-aware · sticky"}:::implemented
  Reserve["원자 usage·budget 예약<br/>Attempt와 선택·제외 이유 기록"]:::implemented
  Call["모델 호출<br/>AI SDK · OpenAI-compatible · Ollama"]:::implemented
  Classify{"응답·오류 분류"}:::implemented
  Success["성공<br/>usage 확정"]:::implemented
  NextAccount["같은 Provider의<br/>다음 건강한 credential"]:::implemented
  Equivalent["동급 model candidate<br/>equivalence·eval 재검사"]:::implemented
  NextProvider["다른 Provider·gateway<br/>호환 candidate"]:::implemented
  Blocked["blocked_model_unavailable<br/>제외 이유·재개 가능 시각"]:::implemented
  Stop["fallback 중단<br/>입력·정책·예산·취소·첫 token 이후 실패"]:::implemented
  Providers["공식 Provider API<br/>OpenAI-compatible gateway · Ollama<br/>외부"]:::external

  Request --> Route
  Route --> Filter
  Filter --> Pool
  Pool --> Policy
  Policy --> Reserve
  Reserve --> Call
  Call --> Providers
  Providers --> Classify
  Classify -->|성공| Success
  Classify -->|401·만료| NextAccount
  Classify -->|429·quota·reset| NextAccount
  Classify -->|5xx·timeout·첫 token 전| NextAccount
  NextAccount -->|계정 있음| Reserve
  NextAccount -->|계정 소진| Equivalent
  Equivalent -->|동급 후보 있음| Pool
  Equivalent -->|동급 후보 소진| NextProvider
  NextProvider -->|호환 후보 있음| Pool
  NextProvider -->|모두 소진| Blocked
  Classify -->|비재시도 오류| Stop
```

| 경계 | 보장 | 실제 위치 |
|---|---|---|
| Credential | AES-256-GCM 암호문과 비밀 아닌 metadata만 저장, master key·평문 미기록 | `packages/router` |
| 계정 분산 | 동일 Provider 여러 credential을 결정론적 정책으로 선택 | `packages/router` |
| 모델 fallback | capability·데이터 정책·예산·equivalence·평가 기준을 모두 통과한 후보만 허용 | `packages/router` |
| 제한 모드 | 모델이 없어도 Identity·Work·조직·승인·기록·진단은 계속 동작 | `packages/router`, `packages/application` |

## 9. 데이터·명령·이벤트 계보

SurrealDB는 AgentOS 데이터의 유일한 실행 정본입니다. Surface의 변경 명령은 인증·scope와 replay 원장을 통과하고, 각 도메인이 자신의 transaction 안에서 상태와 불변 event를 함께 기록합니다. Transactional outbox는 그 event의 참조를 같은 commit에 남기며, projector가 조직별 전역 순서를 가진 공개 event로 변환합니다.

```mermaid
flowchart TB
  classDef implemented fill:#dcfce7,stroke:#166534,color:#14532d,stroke-width:2px;
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  classDef planned fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-width:1px,stroke-dasharray:5 5;
  classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12,stroke-width:2px;

  Surface["Surface command<br/>command ID · correlation ID"]:::implementing
  Auth["Access token 인증<br/>tenant · audience · scope"]:::implementing
  Ledger["Command replay ledger<br/>request hash · lease · terminal result"]:::implementing
  Domain["도메인 공개 Service<br/>revision · 정책 · tenant 재검증"]:::implemented

  subgraph Transaction["하나의 SurrealDB transaction"]
    Record["Domain record<br/>현재 상태·version"]:::implemented
    Event["Immutable domain event<br/>command · sequence · causation"]:::implemented
    Outbox["Transactional outbox reference<br/>source kind · source ID"]:::implementing
    Record --> Event
    Event --> Outbox
  end

  Projector["Public event projector<br/>허용 field mapper · payload hash"]:::implementing
  Sequence["조직별 전역 event sequence<br/>cursor · retention floor"]:::implementing
  SSE["SSE·event replay<br/>Last-Event-ID·cursor 재연결"]:::implementing
  Observer["CLI · TUI · Web · Connector<br/>동일한 공개 상태"]:::implementing
  DB[("SurrealDB 단일 정본")]:::implemented

  subgraph Lineage["Work 결과 계보"]
    Work["Request · Work · Plan · Task"]:::implemented
    Context["ContextVersion · EvidenceBrief"]:::implemented
    Execution["RuntimeExecution · Approval<br/>EngineeringDelivery · ArtifactVersion"]:::implemented
    Verification["AssuranceRun · Verification"]:::implemented
    Records["RecordsRun · WorkRecord<br/>ADR · Changelog · Runbook"]:::implemented
    Growth["Suggestion · Evaluation<br/>Adoption · Effect · Revert"]:::implemented
    Work --> Context
    Context --> Execution
    Execution --> Verification
    Verification --> Records
    Records --> Growth
    Growth -. "원인이 된 Work·Event·Evidence" .-> Work
  end

  Surface --> Auth
  Auth --> Ledger
  Ledger --> Domain
  Domain --> Transaction
  Transaction --> DB
  DB --> Projector
  Projector --> Sequence
  Sequence --> SSE
  SSE --> Observer
  Domain --> Lineage
  Lineage --> DB
```

| 계보 구간 | 장애 시 행동 | 실제 위치 |
|---|---|---|
| command replay | 같은 command·같은 payload는 결과 replay, 다른 payload는 거부 | `packages/application`과 각 도메인 command ledger |
| domain transaction | record·event·outbox 중 하나라도 실패하면 전체 rollback | `packages/storage`, `packages/application` |
| public projection | source reference와 허용 mapper로 복구하며 secret·raw row를 반환하지 않음 | `packages/application` |
| Surface reconnect | 조직 cursor 이후 event를 순서대로 replay | `packages/application`, `apps/cli` |
| 결과 추적 | Work에서 실행·검증·기록·개선 원인까지 immutable ID·checksum으로 연결 | `packages/work`, `packages/assurance`, `packages/records`, `packages/growth` |

## 10. Extension·Registry·격리

Extension은 코어 수정 없이 능력을 추가하지만 Core process, SurrealDB 또는 credential을 직접 받지 않습니다. SDK는 정적 manifest·RPC 계약만 제공하고, Host가 artifact 검사·정책·승인·격리 worker·capability broker·health·rollback을 소유합니다. 공개 Registry의 게시·검색·서명·provenance는 Phase 20 범위입니다.

```mermaid
flowchart LR
  classDef implemented fill:#dcfce7,stroke:#166534,color:#14532d,stroke-width:2px;
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  classDef planned fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-width:1px,stroke-dasharray:5 5;
  classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12,stroke-width:2px;

  Author["Extension 개발자<br/>@massion-ext/name"]:::implemented
  SDK["Extension SDK<br/>manifest v1 · RPC types · author helpers"]:::implemented
  Validate["validate · link · pack<br/>경로·script·manifest·content 검사"]:::implemented
  Artifact["npm 호환 .tgz<br/>byte digest · content manifest"]:::implemented
  Registry["Massion Registry<br/>catalog · trust · signature · provenance<br/>예정 · Phase 20"]:::planned
  Inspect["Host Artifact Inspector<br/>name·version·digest·compatibility·trust"]:::implemented
  Governance["Governance<br/>install · permission increase<br/>auto 또는 review 정책"]:::implemented
  Store["불변 artifact·version 원장<br/>active pointer"]:::implemented
  Supervisor["Worker Supervisor<br/>session · restart · health"]:::implemented
  Sandbox["별도 process<br/>Node permission + OS sandbox"]:::implemented
  Worker["Extension worker<br/>bounded JSON Lines RPC"]:::implemented
  Broker["Capability Broker<br/>매 호출 tenant·permission·quota 검증"]:::implemented
  Core["Runtime · Organization · Growth<br/>Records · Surface public ports"]:::implemented
  Database[("SurrealDB")]:::implemented
  Credential["Credential Vault"]:::implemented
  Update["update 후보 health 검사<br/>원자 activate"]:::implemented
  Rollback["직전 healthy version rollback"]:::implemented

  Author --> SDK
  SDK --> Validate
  Validate --> Artifact
  Artifact -. "publish" .-> Registry
  Artifact --> Inspect
  Registry -. "download" .-> Inspect
  Inspect --> Governance
  Governance --> Store
  Store --> Supervisor
  Supervisor --> Sandbox
  Sandbox --> Worker
  Worker --> Broker
  Broker --> Core
  Core --> Database
  Broker --> Credential
  Store --> Update
  Update --> Supervisor
  Update -. "health 실패" .-> Rollback
  Rollback --> Store
  Worker -. "직접 접근 금지" .-> Database
  Worker -. "secret 원문 접근 금지" .-> Credential
```

| 신뢰 수준 | 활성화 경계 | sandbox가 없을 때 |
|---|---|---|
| built-in | child process + Node permission + broker | 같은 Massion release 검증 책임으로 실행 가능 |
| verified | 위 경계 + OS sandbox | 설치 가능, 활성화 차단 |
| community | 위 경계 + OS sandbox | 설치 가능, 활성화 차단 |
| untrusted-local | 위 경계 + OS sandbox | validate·link·설치 가능, 활성화 차단 |

구현은 `packages/extension-sdk`와 `packages/extension-host`에 있습니다. Registry·Marketplace는 `docs/superpowers/plans/2026-07-10-massion-agentos-1.0-program.md`의 Phase 20에서 완성합니다.

## 11. 개인·팀 배포 구조

Massion 1.0은 개인 로컬 설치와 팀 자체 호스팅을 공식 변형으로 둡니다. 개인 모드는 한 명의 owner가 있는 조직일 뿐 데이터 모델을 축약하지 않습니다. 팀 모드는 같은 Application API와 tenant 격리를 네트워크 서비스로 배포합니다. 아래 팀 운영 조립은 Phase 21 예정이며 현재 완료 상태가 아닙니다.

```mermaid
flowchart LR
  classDef implemented fill:#dcfce7,stroke:#166534,color:#14532d,stroke-width:2px;
  classDef implementing fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:3px;
  classDef planned fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-width:1px,stroke-dasharray:5 5;
  classDef external fill:#ffedd5,stroke:#c2410c,color:#7c2d12,stroke-width:2px;

  subgraph Local["개인 로컬 설치 · 사용자 OS"]
    LocalUser["개인 owner"]:::implemented
    LocalSurface["local CLI · TUI · Web<br/>CLI·TUI 구현됨, Web 예정"]:::implementing
    LocalCore["Massion AgentOS process<br/>Application · Core Office · Runtime"]:::implementing
    LocalWorkers["격리 Extension child process"]:::implemented
    LocalDB[("embedded persistent SurrealDB<br/>로컬 단일 정본")]:::implemented
    LocalFiles["사용자 Git·workspace<br/>OS filesystem"]:::external

    LocalUser --> LocalSurface
    LocalSurface -->|loopback| LocalCore
    LocalCore --> LocalDB
    LocalCore --> LocalWorkers
    LocalCore --> LocalFiles
  end

  subgraph Team["팀 자체 호스팅 · Phase 21 예정"]
    TeamUsers["팀 사용자·관리자"]:::planned
    Proxy["TLS reverse proxy<br/>remote bind·CORS·rate limit"]:::planned
    Apps["Application service replica<br/>HTTP · SSE · auth"]:::planned
    RuntimePool["Runtime·Extension worker pool<br/>sandbox backend"]:::planned
    SharedDB[("원격 SurrealDB<br/>공유 tenant 정본")]:::planned
    Backup["암호화 backup·restore<br/>migration·integrity gate"]:::planned
    K8s["Docker Compose · Kubernetes<br/>배포·health·rollout"]:::planned

    TeamUsers --> Proxy
    Proxy --> Apps
    Apps --> RuntimePool
    Apps --> SharedDB
    RuntimePool --> SharedDB
    SharedDB --> Backup
    K8s -. "배포 조립" .-> Apps
    K8s -. "배포 조립" .-> RuntimePool
  end

  Registry["Massion Registry<br/>예정"]:::planned
  Providers["공식 AI Provider API<br/>외부"]:::external
  LocalCore --> Providers
  Apps --> Providers
  LocalCore -. "Extension 설치" .-> Registry
  Apps -. "Extension 설치" .-> Registry
```

| 배포 변형 | 현재 상태 | 신뢰·운영 경계 |
|---|---|---|
| 개인 로컬 | 도메인·저장소·Runtime·Extension Host·Application API·CLI·TUI 구현됨, Web·설치 조립 예정 | loopback bootstrap, OS 사용자 권한, 로컬 DB 경로당 단일 연결 |
| 팀 자체 호스팅 | 제품 범위 승인, 운영 조립 예정 | TLS, remote auth, tenant 격리, shared DB, sandbox, backup·restore |
| 관리형 Massion Cloud | 1.0 범위 밖 | 호환 가능한 멀티테넌트 계약만 유지하고 내부 구조는 이 문서에서 설계하지 않음 |

## 12. 구현 위치와 Phase 상태 색인

| 영역 | 상태 | 구현·설계 위치 | Phase |
|---|---|---|---|
| 제품 헌법·품질·저장소·Identity·Organization | 구현됨 | `docs/phases/00-document-lineage` ~ `docs/phases/04-organization-graph-core-office` | 0~4 |
| Work·Router·Runtime·Governance | 구현됨 | `packages/work`, `packages/router`, `packages/runtime`, `packages/governance` | 5~8 |
| Context·Evidence·Engineering·Assurance·Records·Growth | 구현됨 | `packages/context-strategy`, `packages/evidence`, `packages/software-engineering`, `packages/assurance`, `packages/records`, `packages/growth` | 9~14 |
| Extension SDK·Host | 구현됨 | `packages/extension-sdk`, `packages/extension-host` | 15 |
| Application API·CLI | 구현됨 | `packages/application`, `apps/cli` | 16 |
| TUI | 구현됨 | `apps/tui` | 17 |
| Web·외부 Surface·Registry·운영·강화·1.0 | 예정 | `docs/superpowers/plans/2026-07-10-massion-agentos-1.0-program.md` | 18~23 |

이 문서의 상태가 프로그램 계획과 달라지면 실제 검증 근거를 확인한 뒤 그림, 표와 기준 커밋을 함께 갱신합니다.

### 검증 기록

2026-07-11에 다음 검증을 실행했습니다.

| 검증 | 결과 |
|---|---|
| `pnpm verify:architecture` | Mermaid CLI 11.16.0으로 10개 SVG 렌더링 통과 |
| `node scripts/verify-docs.mjs` | 문서 구조·로컬 링크·금지된 임시 표기 검사 통과 |
| `git diff --check` | 공백·충돌 표식 검사 통과 |
| 브라우저 1440px 및 가로 스크롤 미리보기 | 한글 라벨 잘림·노드 겹침 없음, 상태 색·실선·점선 구분 확인 |

로컬 검증 스크립트는 설치된 Chrome·Chromium을 사용합니다. 자동 탐지 경로에 브라우저가 없으면 `MASSION_MERMAID_BROWSER` 환경 변수에 실행 파일 경로를 지정합니다.
