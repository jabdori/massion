# Massion AgentOS 1.0 전체 아키텍처

> **문서 상태**: 현재 구현 아키텍처 정본
> **기준일**: 2026-07-11
> **기준 커밋**: `7457921`
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

기준 커밋에서 Phase 0~15는 구현됨, Phase 16은 구현 중, Phase 17~23은 예정입니다. 개별 요소는 Phase 번호만으로 판정하지 않고 실제 코드와 검증 결과를 함께 확인합니다.

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
    CLI["CLI · mass<br/>구현 중 · Phase 16"]:::implementing
    TUI["TUI<br/>예정 · Phase 17"]:::planned
    Web["Web Console<br/>예정 · Phase 18"]:::planned
    Channels["Slack · Discord · GitHub<br/>예정 · Phase 19"]:::planned
  end

  API["Application API<br/>인증 · 명령 · 조회 · SSE<br/>구현 중 · Phase 16"]:::implementing
  Coordinator["핵심 업무 조정기<br/>(CoreWorkCoordinator)<br/>구현 중 · Phase 16"]:::implementing

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
  Person -.-> TUI
  Team -.-> Web
  Team -.-> Channels
  CLI ==> API
  TUI -.-> API
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
| CLI·Application API | 구현 중 | `apps/cli`, `packages/application` | [Phase 16 설계](../phases/16-application-api-cli/design.md) |
| Core Office·Work·Governance | 구현됨 | `packages/organization`, `packages/work`, `packages/governance` | [Phase 4 회고](../phases/04-organization-graph-core-office/review.md), [Phase 5 회고](../phases/05-work-collaboration-records/review.md), [Phase 8 회고](../phases/08-governance-approval/review.md) |
| Runtime·Router | 구현됨 | `packages/runtime`, `packages/router` | [Phase 6 회고](../phases/06-provider-credential-router/review.md), [Phase 7 회고](../phases/07-voltagent-runtime-adapter/review.md) |
| Extension Host | 구현됨 | `packages/extension-host` | [Phase 15 회고](../phases/15-extension-sdk-host/review.md) |
| TUI·Web·외부 Surface·Registry | 예정 | `docs/superpowers/plans/2026-07-10-massion-agentos-1.0-program.md` | 프로그램 Phase 17~20 |
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

Core Office의 불변 조직과 전문 조직·Extension 조직의 차이를 설명합니다.

## 5. Work 처리 전체 흐름

모든 요청이 Work가 되어 계획·근거·실행·검증·기록·개선으로 이어지는 경로를 설명합니다.

## 6. 실행·승인·차단·취소·복구

자동 실행과 선택적 사람 승인, 모델 부재, 취소, 장애 복구를 성공과 구분해 설명합니다.

## 7. 에이전트 협업과 대화

조직 Agent map, 협업방, 직접·다자 대화와 병렬 실행의 Work 귀속 관계를 설명합니다.

## 8. 모델 계정·Provider 라우팅

동일 Provider의 여러 계정 회전과 동급 모델·다른 Provider fallback 정책을 설명합니다.

## 9. 데이터·명령·이벤트 계보

명령 replay, 도메인 transaction, outbox, 공개 이벤트와 SSE cursor 계보를 설명합니다.

## 10. Extension·Registry·격리

Extension 작성부터 검증·배포·격리 실행·업데이트·rollback까지의 신뢰 경계를 설명합니다.

## 11. 개인·팀 배포 구조

OS 위 개인 로컬 설치와 팀 자체 호스팅의 프로세스·네트워크 경계를 설명합니다.

## 12. 구현 위치와 Phase 상태 색인

| 영역 | 상태 | 구현·설계 위치 | Phase |
|---|---|---|---|
| 제품 헌법·품질·저장소·Identity·Organization | 구현됨 | `docs/phases/00-document-lineage` ~ `docs/phases/04-organization-graph-core-office` | 0~4 |
| Work·Router·Runtime·Governance | 구현됨 | `packages/work`, `packages/router`, `packages/runtime`, `packages/governance` | 5~8 |
| Context·Evidence·Engineering·Assurance·Records·Growth | 구현됨 | `packages/context-strategy`, `packages/evidence`, `packages/software-engineering`, `packages/assurance`, `packages/records`, `packages/growth` | 9~14 |
| Extension SDK·Host | 구현됨 | `packages/extension-sdk`, `packages/extension-host` | 15 |
| Application API·CLI | 구현 중 | `packages/application`, `apps/cli` | 16 |
| TUI·Web·외부 Surface·Registry·운영·강화·1.0 | 예정 | `docs/superpowers/plans/2026-07-10-massion-agentos-1.0-program.md` | 17~23 |

이 문서의 상태가 프로그램 계획과 달라지면 실제 검증 근거를 확인한 뒤 그림, 표와 기준 커밋을 함께 갱신합니다.
