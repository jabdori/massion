# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop

## Users

주 사용자는 **자기 Mac에 직접 설치해 쓰는 개인 개발자와 1인 팀**입니다. 서명·공증된 macOS 데스크톱 앱을 설치하고, 로컬 daemon과 AI 에이전트 조직에 업무를 맡기는 흐름이 첫 메인 릴리스 목표입니다. 설계 기준은 "이 제품을 오늘 처음 설치한 외부 개인 개발자"이며, 사내 온보딩이나 사전 설명을 전제하지 않습니다.

근시일 최다 사용 시간은 소유자 본인의 도그푸딩에서 나오지만, 그것은 검증 경로이지 설계 대상이 아닙니다.

현재 공개 설치 가능한 릴리스는 없습니다. 2026-07-15에 게시됐던 `v1.0.0`은 개인용 데스크톱 완성·배포 게이트를 통과하지 못해 2026-07-24 릴리스와 원격 태그를 철회했습니다. 기존 `install.sh`, CLI·TUI·Web 묶음과 팀 자체 호스팅은 코드에 남은 레거시 배포 경로이며 개인용 메인 릴리스 표면이 아닙니다.

## Product Purpose

사용자가 사명(Mission) 하나를 맡기면 여러 AI 에이전트가 실제 조직처럼 책임을 나누어 영속 업무(Work)를 수행합니다. 사람이 통제하는 승인·검증·기록을 거치고, 검증된 경험만 다음 조직·기억·정책을 바꿉니다.

성공의 정의는 **사용자가 Work 하나를 요청부터 완료 판정까지 끝까지 신뢰하며 지켜볼 수 있는 것**입니다. 실행이 지금 어디 있고, 무엇을 기다리며, 왜 막혔고, 무엇을 결정해야 하는지가 화면에서 읽히지 않으면 나머지 기능은 의미가 없습니다.

현재 확정된 작업 우선순위는 다음과 같습니다.

1. 프론트엔드를 백지에서 다시 만듭니다.
2. 그 위에서 Work 전 과정이 의도대로 동작하는지 확실히 검증합니다.
3. 그 둘이 서 있어야 Massion이 스스로를 고치는 부트스트랩이 가능합니다.

## Positioning

Massion은 모델을 고를 수 있는 채팅 앱도, 에이전트 여러 개를 띄우는 런처도 아닙니다. 이웃 제품이 그대로 따라 주장할 수 없는 메커니즘은 다음 넷입니다.

- **대화가 아니라 Work와 불변 사건이 정본입니다.** 모델 transcript만으로 조직 상태나 완료를 복원하지 않습니다.
- **완료는 모델의 선언이 아니라 실행 책임과 분리된 독립 Assurance가 판정합니다.**
- **로컬·자체 호스팅이 정본이며 Provider가 제품 상태를 소유하지 않습니다.** 모든 모델 경로가 실패해도 조회·승인·취소·진단은 제한 모드로 동작합니다.
- **자가개선은 근거와 효과 평가를 거친 보수적 채택입니다.** 모델이 스스로 프롬프트를 고쳐 즉시 적용하는 기능이 아닙니다.

## Operating Context

- 실행 형태는 macOS arm64를 첫 대상으로 하는 데스크톱 앱입니다. `apps/desktop`이 화면과 수명 주기를 직접 소유합니다.
- 프로세스 경계는 네 계층입니다: React·Vite 렌더러 → Tauri 호스트 → Node.js bridge sidecar → Massion daemon.
- daemon은 앱 창과 수명이 같지 않습니다. 앱을 닫아도 daemon과 데이터는 남습니다.
- 모든 영속 상태는 SurrealDB 단일 정본에 있습니다. 화면은 Application API의 query·command·event stream만 소비합니다.
- 사용자의 실제 루틴은 업무를 만들고, 실행 사건을 지켜보고, 승인 요청에 응답하고, 산출물과 검증 결과를 확인하는 것입니다.
- 사용자의 일은 자기 기계의 **로컬 디렉토리(워크스페이스)**와 묶입니다. 워크스페이스는 이름·경로·신뢰 상태(`pending`/`trusted`/`blocked`)·최근 사용 시각을 가진 1급 도메인 객체이며, 워크스페이스에 묶인 Work는 사용자가 그 디렉토리를 신뢰하기 전까지 도구 실행이 차단됩니다.
- Work가 워크스페이스에 묶이는 것은 **선택**입니다. 워크스페이스가 하나도 없는 상태는 오류가 아니라 정상 상태이며, 처음 설치한 사용자는 항상 그 상태에서 시작합니다. 디렉토리가 필요 없는 조사·판단·문서 업무가 실재합니다.
- 검증 근거는 `docs/evidence/`에 날짜별 파일로 남기며, 실행 결과와 짝지어지지 않은 완료 주장은 인정하지 않습니다.

## Capabilities and Constraints

**확정된 기능 사실**

- Work의 종료 상태는 `completed`, `awaiting-approval`, `blocked`, `failed`, `cancelled` 다섯입니다. 모델 경로 소진은 실패가 아니라 재시도 가능한 `blocked`로 보존됩니다.
- Provider 자격 증명이 없어도 조직·업무·기록은 동작하며 모델 호출만 차단됩니다(제한 모드).
- Provider 자격 증명은 개인 사용자가 자기 계정의 키를 자기 로컬 앱에 직접 등록합니다(BYOK). Massion은 자격 증명·계정·구독 할당량을 다른 사용자나 서버에 공유·대여·재판매·프록시하지 않습니다.
- 승인이 필요한 실행은 사람의 결정 전까지 정지하며, 정책이 자동이면 사람을 기다리지 않습니다.
- 여러 에이전트가 하나의 Work에 귀속된 협업방에서 메시지·handoff를 주고받고, 독립 Task는 병렬 실행됩니다.

**기술 제약 (설계 취향이 아니라 런타임 사실)**

- 렌더러는 daemon URL과 인증 토큰을 받지 않습니다. 범용 shell·filesystem 권한도 없습니다. CSP는 `default-src 'self'` 기준입니다. 승인된 ADR이 정한 실행 경계이며 화면 설계가 우회할 수 없습니다.
- 최소 창 크기는 1180×720입니다. 모바일 축소 레이아웃은 첫 릴리스 범위가 아닙니다.
- Work revision과 approval revision 충돌은 화면이 추측해 덮어쓰지 않고 오류로 표시한 뒤 다시 읽습니다.

**프론트엔드 작업 방식 (2026-07-23 확정)**

화면은 **완성본을 기준으로** 만듭니다. 현재 런타임이 만들지 않는 데이터라도, 제품이 도달해야 할 상태를 화면이 먼저 고정합니다. 그래야 무엇이 빠졌는지가 드러납니다.

그 과정에서 문서와 구현이 어긋난 것을 발견하면 다음 순서로 처리합니다.

1. **문서는 즉시 고칩니다.** 구현되지 않은 것을 구현됐다고 적은 문서는 다음 사람을 속입니다.
2. **구현은 핸드오프 문서로 넘깁니다.** 다른 에이전트가 이어받아 구현한 뒤 연결만 하면 되도록, 연결 지점·계약·완료 판정을 구체적으로 적습니다.
3. **프론트엔드는 멈추지 않습니다.** 런타임 구현을 기다리지 않고 계속 진행합니다.

화면의 fixture가 실제 런타임보다 앞서 있는 것은 결함이 아니라 이 방식의 결과입니다. 다만 **어느 부분이 앞서 있는지는 반드시 문서로 남깁니다.**

작성된 핸드오프:

- [에이전트 협업 런타임](docs/phases/30-surface-parity-agent-ux/agent-collaboration-runtime-handoff.md) — VoltAgent 위임을 협업방에 기록
- [개선 채택·거부·되돌리기](docs/phases/30-surface-parity-agent-ux/growth-adoption-handoff.md) — 자가개선 command를 계약에 노출
- [확장 Capability](docs/phases/30-surface-parity-agent-ux/extension-capability-handoff.md) — 설치된 확장이 조직에 무엇을 더했는지 계약에 노출
- [설정 조회 계약](docs/phases/30-surface-parity-agent-ux/settings-contract-handoff.md) — `router.*`·`subscription.*` 일곱 조회에 타입 주기

핸드오프를 현재 데스크톱과 실제 검증 순서로 통합한 실행 문서:

- [제품 통합·정합성 설계](docs/superpowers/specs/2026-07-24-phase-30-product-integration-design.md) — 현재 기준선, 세로 흐름 순서와 전체 완료 판정
- [홈·워크스페이스·파일 문맥](docs/superpowers/specs/2026-07-24-desktop-home-context-design.md) — 내부 ID 없는 새 사명 입력과 네이티브 문맥 선택
- [Runtime·Application·표면 계약 수렴](docs/superpowers/specs/2026-07-24-runtime-contract-convergence-design.md) — 네 핸드오프와 실제 코드 연결점
- [실제 데스크톱 UAT](docs/superpowers/specs/2026-07-24-desktop-live-uat-design.md) — Computer Use 기반 핵심 12개·확장 4개 시나리오
- [통합 구현 계획](docs/superpowers/plans/2026-07-24-phase-30-product-integration.md) — 파일·명령·커밋 단위 실행 순서

**표면 결정 (2026-07-24, 사용자 논의로 확정)**

- **홈 = 여러 도메인을 가로지르는 대시보드.** 다른 다섯 표면은 각자 한 도메인을 깊게 봅니다(업무=Work, 개선=Growth, 조직=Organization, 확장=Extension, 설정=Router·Subscription·실행 정책). 승인은 별도 표면이 아니라 어느 화면에서나 여는 지속형 `수신함`에 남습니다. 가로로 집약하는 곳이 없고, 그게 홈의 고유 가치입니다. 대표와의 대화방 안은 **도메인이 거부합니다** — `collaboration_room.work_id`가 필수라 Work 없는 방은 존재할 수 없고, 그런 방을 만들면 그냥 업무 하나가 됩니다. 이름은 `대표·홈` → `홈`으로 줄였습니다.
- **에이전트 이름은 handle에서 파생합니다.** 역할명(`Representative`)은 병렬 편성 시 겹치므로 이름이 될 수 없습니다. `agentIdentityToken`이 Atlas·Lyra·Quill… 24개 호출부호를 소유하고, 모든 표면이 이걸 거칩니다. Atlas 세트는 첫 글자 8개가 서로 달라 아바타 이니셜이 겹치지 않습니다.
- **조직 화면 = 구조(A) + 지도(B) 하이브리드** (2026-07-24, 목업·실물 비교 후 확정). 본문 A는 자식이 있는 노드를 접을 수 있는 중첩 구조, 우측 B는 전체 위치를 보여주는 지도입니다. A가 읽기의 중심임을 유지하면서 지도 판독 폭을 확보하도록 55:45로 나눕니다. 현재 도메인의 `NodeRole`은 총괄·조율·실행만 구분하므로 `coordinator`를 부서나 팀으로 단정하지 않습니다. 정확한 부서·팀·팀장·구성원 구분은 조직 단위 종류와 Agent 소속 계약이 추가돼야 합니다. 편성 command가 열리면 지도는 드래그 편성 캔버스로 승격합니다. `@xyflow/react` 사용.
- **미해결 — 동적 노드 이름 충돌.** 배정 호출부호가 16개(`ASSIGNABLE_CALL_SIGNS`)뿐이라 handle 해시 충돌 시 다른 노드가 같은 이름을 받습니다(예: `software-engineering`·`security-reviewer` 둘 다 Wren). 조직이 커질수록 겹칩니다. `agentIdentityToken`이 조직 맥락 없이 순수 함수라 전역 dedupe가 불가 — 투영 단계 dedupe나 호출부호 풀 확장이 필요합니다. 별도 작업.

**명시적으로 미결정인 사실**

- **홈의 블록 구성은 계약이 넓어지면 채워집니다.** 지금은 Work·Approval·차단·`개선`(awaiting-review)을 집약합니다. `조직 변경 제안`은 전역 조회가 없어 아직 빠져 있습니다.
- **화면 언어는 재검토 대상입니다.** 현재 코드와 문서는 한국어이나 이번 재작성에서 고정된 전제로 두지 않습니다.
- `apps/web`과 `apps/tui`는 제거하기로 확정됐습니다. 제거 전에 릴리스 스크립트, Caddy 배포 이미지, 설치 테스트, 구독 UAT의 산출물 참조를 먼저 끊어야 합니다.

## Brand Commitments

`Massion`은 저장소·CLI 명령·패키지 이름으로 쓰입니다. 로고, 서체 라이선스, 색 규정, 목소리 가이드 중 확정된 것은 없습니다.

**크래프트 기준선**은 Linear · Claude Code Desktop · Vercel 대시보드입니다. 사용자가 지정했으며, 이 화면이 그 셋 옆에 놓였을 때 밀도·정렬·타이포 위계에서 밀리지 않는 것이 품질 하한입니다.

기존 `apps/web`·`apps/tui`의 화면과 amber·암갈색 데스크톱 시안은 **교체 대상**입니다. 반례로만 참조하며 부분 보정하지 않습니다.

시각 세계는 `apps/desktop/DESIGN.md`가 소유합니다(2026-07-23 승인: 협업방 중심, UI 무채 + 에이전트별 색, 노랑은 사람이 필요한 곳 전용, 점선은 `scope:"work"`와 미승인 전용).

## Evidence on Hand

**실재하는 것**

- 개인 소유 Z.AI GLM Coding Plan 키의 로컬 실행 UAT 2건: `docs/evidence/phase-30/glm-dogfooding-uat-2026-07-20.md`, `glm-dogfooding-uat-2026-07-21.md`. 개발·테스트 작성·실패 패치와 개인용 Massion 도그푸딩에 `glm-5.2`를 계속 사용합니다. 키·계정·할당량은 소유자 밖으로 공유하지 않습니다.
- 업무 협업 UAT: `docs/evidence/phase-30/work-collaboration-local-uat-2026-07-20.md`. Core Office 협업방 9명 참가자, handoff 정상.
- Software Engineering 조직이 Git fixture에서 RED→GREEN 변경 후 독립 Assurance를 통과한 기록.
- Evidence 패키지의 Tree-sitter 기반 파일·symbol·chunk·relation 인덱스, exact·BM25 검색, 선택적 embedding port, CodeGraphService와 EvidenceBrief 계약.
- Growth 패키지의 versioned MemoryVersion·PromptVersion 합성 및 RuntimeExecution memory lineage 계약.
- 품질 게이트 실측: ESLint 0, 4개 패키지 typecheck 통과, 테스트 518건 통과(commit `938709f` 기준).

**없는 것 — 앞으로 지어내면 안 되는 것**

- 고객, 사용자 후기, 사례 연구, 채택 수치, 벤치마크 비교, 가격, 공개 배포 라이선스 승인.
- 복수 Provider 계정의 quota 소진·fallback 실증. 단일 GLM 계정만 검증됐습니다.
- Claude 소비자 구독 실계정 UAT.
- 접근성 실측. 코드 구현은 있으나 스크린리더 실사용 확인은 하지 않았습니다.
- 데스크톱 자체의 사용자 UAT. 데스크톱 구현체는 커밋됐고 fixture 기반 테스트는 통과하지만, Tauri → bridge → daemon → 실제 Provider를 거치는 사용자 조작 검증은 아직 없습니다.
- Workspace 자동 색인·검색·CodeGraph 결과가 실제 Work의 Representative·Strategy·Delivery 입력과 데스크톱 citation으로 이어지는 생산 경로.
- 개인 MemoryVersion이 생산 WorkService·Agent instruction에 주입되는 경로와 실제 재시작·사용 중지 UAT.
- LSP client/server 구현. 현재 저장소에는 LSP 구현이나 의존성이 없으며 완료 기능으로 주장하지 않습니다.
- 서명·공증된 앱의 깨끗한 Mac 설치·수동 업데이트·제거, 앱 교체·재시작 뒤 데이터 지속성, daemon 비정상 종료 복구, 키보드·VoiceOver 실측.

## Product Principles

1. **신뢰가 첫 기능이다.** 사용자가 지금 무슨 일이 벌어지는지 읽지 못하면 다른 모든 기능은 존재하지 않는 것과 같다.
2. **Work 하나의 완주가 표면 넓이보다 우선한다.** 요청에서 완료 판정까지가 끝까지 서기 전에는 표면을 늘리지 않는다.
3. **사람의 권한은 축소하지 않는다.** 자동 모드는 개입 빈도를 줄일 뿐 승인·중단·되돌리기 가능성을 제거하지 않는다.
4. **모델이 없어도 제품은 동작한다.** 차단은 실패로 위장하지 않고 재개 가능한 상태로 보인다.
5. **완료는 선언이 아니라 검증이다.** 산출물의 존재나 에이전트의 보고를 완료로 표시하지 않는다.

## Accessibility & Inclusion

키보드만으로 모든 기능에 도달할 수 있어야 하고, focus는 항상 눈에 보여야 하며, 대화상자에는 label이 있어야 하고, 명암 대비를 지켜야 합니다. 제품 헌법이 축소 불가 항목으로 규정한 최소선입니다.

현재 상태는 코드 구현만 있고 실측이 없습니다. 스크린리더 실사용 확인은 미완이며 완료로 표시하지 않습니다.
