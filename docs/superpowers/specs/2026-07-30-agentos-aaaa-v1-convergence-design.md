# Massion AgentOS AAAA v1 수렴 설계

> 날짜: 2026-07-30
> 상태: 구현 기준
> 기준선: `c908c9e5db5e89d8f6009600ba9f25f10e81132b`와 그 위의 사용자 작업 트리
> 목표: 하나의 실제 Work가 요청부터 독립 검증·기록·개선까지 완주하고, 모든 표면이 같은 정본과 같은 언어를 사용하며, 안전하게 설치 가능한 macOS v1을 만든다.

## 1. 결정

표면별 미감 보정이나 코어만의 정리로 끝내지 않는다. 다음 순서의 **세로 흐름 수렴 방식**을 사용한다.

1. 데이터 손실·중복 실행·권한 우회가 가능한 코어와 보안 경계를 먼저 닫는다.
2. Work 하나의 계보를 Knowledge·Provider·Budget·Growth까지 실제 Application 계약으로 연결한다.
3. fixture와 live adapter에 같은 계약 검사를 적용하고 성공하는 무동작 명령을 없앤다.
4. 같은 상태·용어·색·행동과 문맥 이동을 모든 표면에 적용한다.
5. 같은 후보 SHA에서 실제 Codex 실행, 비정상 종료, 23개 Tauri UAT, 접근성, 서명·공증을 검증한다.

`apps/desktop/DESIGN.md`는 현재 디자인의 근거와 보존할 시각 언어를 설명하지만 불변 계약은 아니다. 화면의 추가·통합·분리는 사용자가 답하려는 질문과 실제 데이터 소유권으로 결정한다.

## 2. v1 제품 구조

현재 아홉 표면은 서로 다른 질문을 소유하므로 유지한다. 구현 중 질문이 겹치거나 독립 계약이 성립하지 않으면 합치거나 재배치할 수 있다.

| 표면 | 소유 질문 | v1 핵심 행동 |
|---|---|---|
| 홈 | 지금 무엇을 보거나 결정해야 하는가? | 새 Work, 주의 항목, 진행 중 Work 진입 |
| 업무 | 이 사명이 지금 어디까지 왔는가? | 대화, 단계, 지시, 승인, 중단, 산출물, 검증, 기록 |
| 지식 | 조직이 이 작업공간에 관해 무엇을 아는가? | 검색, 1-hop 관계, 근거·인용, Work 이동 |
| 조직 | 누가 어떤 책임으로 일하는가? | 구조·지도, 임시 팀, 변경 제안과 승인 |
| 개선 | 무엇을 배웠고 무엇을 바꿨는가? | 근거, 평가, 채택·거부, 효과, 되돌림 |
| 확장 | 조직에 어떤 능력을 추가할 수 있는가? | Capability·권한 확인, 설치, 상태, 실제 Work 사용 |
| 프로바이더 | 어떤 모델 공급이 사용 가능한가? | Codex/Provider 로그인, 계정·키·모델 discovery, 재인증 |
| 예산 | 무엇을 얼마나 썼고 어디서 막을 것인가? | 실제 route attempt, fallback 사슬, 비용, 알림·차단 한도 |
| 설정 | 사람이 어떤 지속 경계를 정했는가? | 실행 권한, 자가개선 채택 모드 |

사용자에게 요청마다 모델을 선택하게 하지 않는다. Work의 모델·추론 노력 선택기는 제거한다. 조직의 Strategy와 역할별 후보가 모델을 배치하고, 사용자는 Provider에서 공급 모델을 정하며 Budget에서 실제 선택과 비용을 검증한다.

## 3. 일관된 경험 계약

### 3.1 하나의 상태는 하나의 말과 행동을 갖는다

| 의미 | 사용자 문구 | 색 | 가능한 행동 |
|---|---|---|---|
| 사람 결정을 기다림 | 승인 대기 | gate | 승인·거절·근거 보기 |
| 해결 조건 때문에 멈춤 | 차단됨 | halt/danger | 원인 보기·해결 후 재개 |
| 복구 불가능한 종료 | 실패 | danger | 진단 보기·새 실행 |
| 사용자 중단 | 취소됨 | muted | 읽기·새 실행 |
| 검증된 완료 | 완료 | muted/primary | 산출물·검증·기록 보기 |

Home·Inbox·Work·Growth·Extension은 같은 정본의 attention 항목을 사용한다. 검색·필터·pagination은 전역 주의 항목의 개수와 내용을 바꾸지 않는다.

### 3.2 문맥과 계보가 표면 사이에서 이어진다

하나의 Work에서 다음 이동이 내부 식별자 재입력 없이 가능해야 한다.

- Work 근거 → Knowledge node → 원 Work
- Work 실행 → Budget route attempt → Provider/model → 원 Work
- Work 완료 → Growth suggestion/effect → 원 Work와 적용 버전
- Work 참여자 → Organization node → 원 Work room
- Extension tool event → Extension capability → 원 Work audit

선택 객체, 필터, scroll 문맥은 뒤로 돌아왔을 때 복원한다. URL이 필수는 아니지만 surface state는 명시적인 구조체로 보존한다.

### 3.3 보이는 제어는 사실이어야 한다

- 성공 응답은 재조회 가능한 상태 변화를 만든다.
- 아직 계약이 없는 제어는 제거하거나 비활성화하고 이유를 표시한다.
- fixture-only 데이터는 live 기능처럼 가장하지 않는다.
- `0`, 아직 모름, 계약 없음, 연결 실패를 서로 다른 상태로 표현한다.

## 4. 코어 신뢰성 설계

### 4.1 Records

- 저장된 Records run 상태를 continuation cursor로 사용한다.
- `planned → rendering → finalized → completed`에서 이미 지난 단계를 반복하지 않는다.
- Work 완료와 Records run 완료·terminal 사건을 같은 데이터베이스 transaction에서 확정한다.
- fresh, 각 중간 상태, completed replay, 동시 complete, process crash를 fault-injection으로 검증한다.
- Records recovery를 서버 startup에 실제로 연결한다.

### 4.2 Strategy

- Context snapshot 명령과 모델 generation retry 명령의 정체성을 분리한다.
- 실패 전에 저장된 ContextVersion을 재사용하고 부모 선행조건은 완화하지 않는다.
- generation 생성 transaction이 `created | existing` 소유권을 반환하며 소유자만 Provider를 호출한다.
- pending generation은 terminal replay가 아니며, 결정적 runtime 명령으로 재개하거나 명시적 terminal 상태로 수렴한다.
- Strategy recovery를 서버 startup에 연결한다.

### 4.3 Delivery·Application recovery·Growth

- 복구 가능한 모델 부재만 `blocked`로 유지한다.
- 복구 불가능한 Delivery 실패는 Task·Work·ApplicationRun을 같은 의미의 `failed`로 수렴시킨다.
- startup recovery는 안정적 cursor로 모든 page를 소진한 뒤 ready가 된다.
- Growth worker는 새 trigger보다 먼저 `proposed/evaluated` orphan을 결정적 command ID로 재개한다.

## 5. Provider와 Codex 설계

### 5.1 인증

Codex 토큰 파일 내용을 직접 읽거나 복사하지 않는다. 공식 로그인 명령과 기존 관리 profile 경로만 사용한다.

- 현재 전역 Codex가 ChatGPT 로그인 상태인지 비밀 없는 `codex login status`로 확인한다.
- Massion은 계정별 owner-only `HOME/CODEX_HOME`을 사용한다.
- 관리 profile에 유효한 인증이 있으면 `account/read`, doctor, model discovery, quota attest로 재사용한다.
- 관리 profile이 없으면 Massion의 `auth login openai-codex` 흐름으로 공식 브라우저 로그인을 실행한다.
- `auth.json` 내용은 로그·증거·응답에 포함하지 않는다.

공식 현재 권장 모델은 `gpt-5.6-sol`이다. 실제 사용할 모델은 Codex model discovery가 attestation한 모델에 한정하며 문자열을 하드코딩해 인증된 capability를 우회하지 않는다.

### 5.2 Edge·fallback·평가 영수증

- Provider 기본 승인 모드는 각 실행 표면의 capability 교집합에서 선택하고 지원 불가 모드를 기본값으로 만들지 않는다.
- server와 edge connector는 `location`과 `trust_origin` 쌍이 일치해야 한다.
- Codex adapter는 출력·도구 실행 전 명시적 401만 `sideEffectsStarted:false`로 구조화한다. 증명할 수 없는 오류는 계속 true로 취급한다.
- 모델 평가의 후보는 선호 순서가 아니라 허용 집합이다.
- 실제 lease 모델이 평가 대상과 다르면 실행 전에 정산하고 영수증을 만들지 않는다.

## 6. Application 계약과 fixture

### 6.1 live 계약

최소 신규 연결은 다음과 같다.

- global attention/inbox query
- Knowledge index·neighbor graph·links query
- route attempts와 Work·execution·model·Provider·fallback·usage query
- persistent Budget alert/guard command와 Router enforcement
- installed Extension manifest·permission·Capability query
- Growth configuration을 Settings와 Growth가 함께 사용하는 단일 계약
- Provider 계정 추가·Codex 로그인·모델 enablement의 실제 command

### 6.2 fixture의 세 층

1. **계약 fixture**: 모든 query/command, enum, revision, idempotency, secret 비노출을 검증한다.
2. **시나리오 fixture**: active, blocked, approval, completed, Growth lifecycle, Extension install, Provider fallback을 실제 상태 전이로 표현한다.
3. **시각 demo**: 풍부한 이야기와 규모 데이터는 허용하되 모든 제어가 시나리오 상태를 바꾸거나 비활성화되어야 한다.

fixture 상태는 `createFixtureDesktopService()` 인스턴스 내부 한 곳에만 둔다. progress, count, status, budget은 Task·run·verdict·edge·attempt 원본에서 계산한다. 모듈 전역 mutable state와 성공하는 no-op을 금지한다.

## 7. 보안·운영 설계

### 7.1 v1에서 fail-closed로 닫을 경계

- broker와 OS sandbox가 연결될 때까지 non-bundled Extension 활성화를 차단한다.
- loopback bootstrap에 mode 0600의 별도 random owner proof를 요구한다.
- 브라우저 pending session global slot을 제거하고 one-time ticket/state로 교환한다.
- daemon·Surreal start/stop/backup을 owner-only cross-process lifecycle lock으로 감싼다.
- normal/review/automatic 실행은 Workspace 밖 filesystem과 network를 차단하는 macOS sandbox를 사용한다. 사용할 수 없으면 실행을 거부한다.
- full-access만 명시적 책임 경고 후 sandbox를 우회한다.

### 7.2 데이터 복구와 공급망

- backup manifest에 비밀이 아닌 vault key ID를 기록하고 다른 key면 import 전에 실패한다.
- remote restore는 runtime credential을 재설정하고 runtime auth readiness까지 확인한 뒤 완료한다.
- full JS audit와 Rust audit을 signing secret을 사용하는 build 전에 실행한다.
- PostCSS를 모든 advisory의 patched floor 이상으로 올린다.
- SurrealDB 전체 pin을 공식 최신 3.2 patch로 맞추고 local/remote backup·restore와 auth를 재검증한다.
- Tauri capability exact-list Rust test를 실제 최소 권한과 맞추고 release gate에 `cargo test --locked`를 추가한다.

## 8. 시각·접근성 설계

이미 강한 Work·Knowledge·Budget의 밀도, 무채색 기반, 에이전트 정체성 색, gate/halt 의미는 보존한다. 개선 대상은 장식이 아니라 경험의 끊김이다.

- 1180·1360·1440·1600에서 제목·상태·핵심 행동이 잘리지 않는다.
- 같은 46px header rhythm을 원칙으로 하되 정보가 없는 열을 억지로 만들지 않는다.
- loading은 `role=status`, 오류는 `role=alert`, 빈 상태는 다음 행동 또는 정상적인 비어 있음의 의미를 제공한다.
- click/hover 전용 동작을 없애고 native button/link를 사용한다.
- skip link, heading 순서, 고유 접근성 이름, reduced motion을 적용한다.
- WCAG 2.2 AAA 문자 대비와 목표 크기를 기본 수용 기준으로 하되 고밀도 macOS 표면의 예외는 대체 hit area와 키보드 경로를 증명해야 한다.
- visual regression은 개별 screenshot뿐 아니라 Work→Knowledge→Budget→Provider→Work 여정을 묶어 비교한다.

## 9. 검증과 출시

구현 운영은 코어 복구, Provider/Codex, fixture·계약, UI·일관성의 최대 네 독립 축으로 제한한다. 각 축은 구현자 1명과 검수자 1명만 사용하고 재귀 위임하지 않는다. 변경 중에는 표적 실패 테스트를 우선하며, 전체 build·security·hardening은 묶음 경계에서 실행한다. 검증된 원자 변경은 즉시 커밋하고 시각 검수는 UI 묶음에서 집중 수행한다.

각 실패는 다음 loop를 따른다.

1. 원인과 실패 테스트를 확정한다.
2. 가장 작은 공통 경로 패치를 적용한다.
3. 독립 reviewer가 계약·회귀·scope creep를 검토한다.
4. 같은 시나리오를 같은 증거 기준으로 재실행한다.
5. 인접 테스트와 전체 gate를 순서대로 확장한다.

최종 후보는 같은 clean SHA에서 다음을 모두 만족해야 한다.

- format, build, lint, typecheck, 전체 test
- docs, architecture, security, hardening, full dependency audit, Rust test/audit
- 실제 Codex Work 완주와 제한 모드·401 fallback·재인증
- 모든 영속 전이 crash matrix와 backup/restore
- 23개 실제 Tauri 원자 UAT
- 키보드·VoiceOver·반응형·reduced motion·시각 회귀
- Developer ID 서명, 공증, staple, Gatekeeper, 깨끗한 Mac 설치·업데이트·제거·재설치

## 10. 구현 순서

1. 검증 하네스와 작은 공급망/Rust gate를 복구한다.
2. Records·Strategy·Delivery·Growth·startup recovery를 고친다.
3. Codex Edge 정책·401 fallback·평가 영수증을 고친다.
4. bootstrap·session·single-instance·Workspace sandbox·Extension fail-closed를 고친다.
5. global attention·route attempts·Knowledge·Extension·Growth/Settings 계약을 연결한다.
6. fixture state를 한 인스턴스 정본으로 바꾸고 no-op을 제거한다.
7. 표면 간 문맥·용어·행동과 시각·접근성을 통일한다.
8. 실제 Codex/Tauri 시나리오와 릴리스 증거를 같은 SHA에 고정한다.

Phase 31의 전체 작업 인지 모델 배치는 1~7이 통과한 뒤 진행한다. 다만 현재 모델 계보와 평가 영수증 결함은 실제 비용·신뢰를 오염시키므로 v1 전에 수정한다.
