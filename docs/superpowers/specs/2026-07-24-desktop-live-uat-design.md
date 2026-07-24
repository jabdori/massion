# 실제 데스크톱 사용자 인수 검증 설계

> **상태:** 실행 기준 설계
> **최소 통과 수:** 핵심 12개, 지식·기억 4개, 지속 발전 2개, 전체 권한 2개 전부. 조직·확장·설정 3개는 해당 기능 구현 조각 종료 시 전부
> **조작:** 실제 Tauri 앱 + Computer Use

## 1. 검증 대상

브라우저 fixture나 jsdom이 아니라 다음 경계를 전부 지나는 빌드를 검증합니다.

```text
Massion.app
→ React renderer
→ Tauri command/event
→ desktop bridge sidecar
→ daemon
→ SurrealDB
→ Router
→ 자체 애플리케이션 호출이 허용된 실제 Provider
```

## 2. 환경과 비밀값

1. 격리된 `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`과 임시 workspace fixture를 사용합니다.
2. 개인 소유 Provider credential은 존재 여부만 비밀 출력 없이 사전 확인합니다.
3. 키 값은 shell trace, 테스트 출력, 스크린샷, evidence 문서에 기록하지 않습니다.
4. Massion의 기존 `subscription.server.connect-model` 경로로만 전달합니다.
5. Provider·모델 사전 확인이 실패하면 다른 모델로 대체하지 않고 provider-contract drift로 중단합니다.
6. UAT 실행·분석·실패 재현 테스트·코드 패치와 개인용 Massion 도그푸딩은 Z.AI Coding Plan `glm-5.2`를 사용합니다.
7. 키·계정·할당량은 개인 소유자의 로컬 경계에만 두고 공유·대여·판매·중계하지 않습니다. evidence에는 키 값이나 외부 계정 식별자를 남기지 않습니다.

## 3. 조작·관찰 방식

각 시나리오에서 Computer Use는 다음 순서를 지킵니다.

1. 최신 접근성 트리(accessibility tree)를 읽습니다.
2. 가능한 경우 요소 index로 클릭·입력합니다.
3. 행동 뒤 트리를 다시 읽어 stale index 사용을 막습니다.
4. 시각 판단이 필요한 지점은 스크린샷을 저장합니다.
5. 같은 시각의 daemon log와 필요한 read-only query를 연결합니다.

좌표 클릭은 접근성 요소가 없는 네이티브 파일 선택기처럼 필요한 경우에만 사용합니다. 비밀 입력 화면은 키 값이 보이지 않도록 입력 전·완료 후만 캡처합니다.

## 4. 증거 파일

실행 결과는 `docs/evidence/phase-30/desktop-live-uat-YYYY-MM-DD.md`에 기록합니다.

각 시나리오 표에는 다음을 넣습니다.

- 후보 commit SHA
- 앱 빌드 종류와 버전
- 시나리오 ID와 결과
- 시작 데이터 상태
- 사용자 행동
- 화면에서 확인한 결과
- 연결된 Work·run·approval·artifact·verification 식별자
- 스크린샷 파일명
- 실패 시 재현 테스트와 수정 commit

키, 전체 홈 경로, 개인 이메일은 evidence에서 마스킹합니다.

## 5. 핵심 시나리오 12개

### UAT-01 첫 실행과 재연결

- 깨끗한 격리 데이터로 앱을 엽니다.
- 홈·업무·조직·개선·확장·설정과 수신함에 키보드로 접근합니다.
- 앱을 닫고 다시 열어 같은 daemon·데이터를 재사용합니다.

통과: 빈 상태가 오류 없이 보이고 재실행 뒤 bootstrap이 중복 조직이나 daemon을 만들지 않습니다.

### UAT-02 허용된 실제 Provider 연결

- 설정에서 자체 애플리케이션 사용이 허용된 Provider 연결을 엽니다.
- 환경의 키를 비밀 입력에 전달합니다.
- 연결 완료와 Core route 준비 상태를 확인합니다.

통과: 개인 계정은 active/ready이고 Core 필수 route가 준비되며 화면·로그·원격 Massion 서비스에 secret이나 계정 식별자가 노출되지 않습니다.

### UAT-03 워크스페이스 없는 조사 Work

- 홈에서 단순 조사 사명을 입력하고 워크스페이스를 선택하지 않습니다.
- Work 상세로 자동 이동하는지 확인합니다.

통과: 디렉터리 없는 것이 오류가 아니며 Work가 실제 Core 단계와 Assurance를 거쳐 완료됩니다.

### UAT-04 워크스페이스 디렉터리 추가와 신뢰

- 준비된 Git fixture 폴더를 네이티브 선택기로 추가합니다.
- 경로와 권한 영향을 읽고 신뢰합니다.
- 같은 폴더를 다시 추가합니다.

통과: 첫 등록은 pending, 결정 뒤 trusted이며 재등록은 중복 Workspace를 만들지 않습니다.

### UAT-05 파일 첨부와 문맥 반영

- UAT-04의 workspace에서 파일 두 개를 첨부하고 하나를 제거한 뒤 Work를 시작합니다.
- Context & Strategy와 Work 상세의 입력 범위를 확인합니다.

통과: 남은 상대 경로 하나만 정본에 남고 모델이 해당 파일을 근거로 응답합니다.

### UAT-06 워크스페이스 경계 거부

- 선택한 workspace 밖 파일과 밖으로 향하는 symlink를 첨부합니다.

통과: Work 생성 전에 사람이 이해할 수 있는 오류가 나오고 요청·기존 첨부는 보존됩니다.

### UAT-07 실시간 협업방

- 복수 Core Agent가 필요한 사명을 시작합니다.
- 대표 방에서 실제 handoff와 answer를 확인하고 앱을 재시작합니다.

통과: 사용자 요청 외 실제 에이전트 메시지가 2건 이상 추가되고 reply 계보·이름·역할·색이 재시작 뒤에도 유지됩니다.

### UAT-08 실행 중 추가 지시

- 실행 중 `다음 단계에 반영` 지시를 제출합니다.
- 지시 상태와 이후 단계 반영을 확인합니다.

통과: 중복 제출 없이 영속되고 실패 시 입력을 보존합니다.

### UAT-09 승인과 수신함 정합성

- 실행 정책을 `review`로 둡니다.
- 승인 필요한 작업을 실행합니다.
- 홈·수신함·업무의 대기 수와 제목을 비교합니다.
- 수신함에서 소유 화면으로 이동해 승인합니다.

통과: 세 곳이 같은 항목을 보며 승인 뒤 run이 재개되고 모든 집계에서 제거됩니다.

### UAT-10 차단과 재개

- Provider를 일시적으로 사용할 수 없는 조건에서 Work를 시작하거나 quota 차단 fixture를 사용합니다.
- 원인을 확인하고 조건을 복구한 뒤 재개합니다.

통과: 실패로 위장하지 않고 blocked로 남으며 같은 Work·run 계보에서 재개합니다.

### UAT-11 취소

- 실행 중 Work를 취소하고 다시 앱을 엽니다.

통과: 새 artifact·완료 기록이 취소 뒤 생기지 않고 상태가 cancelled로 유지됩니다.

### UAT-12 완료·산출물·Assurance·Records

- 코드 변경 Work를 끝까지 실행합니다.
- 산출물, 검증 기준·결과, Records와 최종 상태를 확인합니다.

통과: 독립 검증이 통과하고 Records가 남은 뒤에만 completed가 표시됩니다.

## 6. 도메인 확장 시나리오 4개

### UAT-13 조직 구조·지도·제안

- 구조에서 Agent를 선택해 지도 중앙 이동을 확인합니다.
- 지도에서 다른 Agent를 선택해 접힌 구조가 열리고 같은 행으로 이동하는지 확인합니다.
- 조직 이동 제안을 만들고 영향·검사·버전을 본 뒤 승인합니다.

통과: 구조·지도·상세가 같은 node를 가리키고 승인 전 조직 snapshot은 바뀌지 않습니다.

### UAT-14 개선 평가·승인·효과·되돌리기

UAT-14는 아래 두 필수 하위 시나리오가 모두 통과해야 합니다.

#### UAT-G01 기본 검토형 지속 발전

- 깨끗한 개인 설치에서 `업무가 끝나면 개선 후보 찾기`가 켜져 있고 반영 방식이 `검토 후 반영(review)`인지 확인합니다.
- 실제 Provider Work 하나를 독립 Assurance와 Records까지 완료하고, 그 Work가 만든 개선 후보를 엽니다.
- 원인 Work·Message·Artifact·Evidence·검증 출처, 필수·보강·반대 신호, 자기평가와 독립 신호의 구분, target diff와 expected effect를 확인합니다.
- 승인 전 target version이 바뀌지 않고 수신함·홈·개선 상세이 같은 검토 대기 항목을 가리키는지 확인합니다.
- 개선 상세에서 승인하고 새 Work를 만들어 PromptVersion·MemoryVersion·PolicyVersion 또는 OrganizationVersion 중 해당 target의 after version이 다음 Work부터 사용되는지 확인합니다.

통과: 완료 Work→ReflectionSnapshot→eligible Evaluation→사람 승인→새 target version→후속 Work가 같은 source·checksum 계보에 있고, 승인 전이나 기존 Work에는 변경이 소급되지 않습니다.

#### UAT-G02 사용자 선택 자동 반영과 복원

- 설정에서 영향을 읽고 `검증되면 자동 반영(auto)`을 명시적으로 선택합니다.
- 실제 완료 Work에서 독립 신호를 포함한 eligible 개선 후보를 만들고, 개별 승인 없이 채택되며 수신함 검토 항목은 생기지 않는지 확인합니다.
- 새 Work가 자동 채택된 version을 사용하고 개선 화면에서 source·evaluation·before/after version·EffectContract를 계속 열 수 있는지 확인합니다.
- read-only query로 baseline과 observation이 실제 Work·사용 target version·AssuranceRun·Verification·Records·metric observation ID와 checksum을 가리키며 Renderer 요청에 raw score가 없음을 대조합니다.
- 동일한 측정 계약의 후속 Work에서 실제 terminal Assurance 표본이 `degraded`가 되게 하고, 노출 중단 직후 새 Work가 suspended version을 사용하지 못하는지 확인합니다. 이어서 자동 또는 승인된 이전 version 복원을 확인한 뒤 다시 새 Work를 시작합니다.
- 설정을 `review`로 되돌리고 이후 후보가 자동 반영되지 않는지 확인합니다.

통과: 사용자가 켠 기간에만 적격 후보가 자동 채택되고, Policy·Governance 승인 요구가 있는 후보는 검토 대기로 승격되며, 임의 점수가 아니라 검증된 업무 표본으로 저하를 판정하고 다음 Work는 suspended version이 아닌 복원 version을 사용합니다. Prompt·Memory·Policy·Organization 네 target의 동일 동작은 제품 통합 테스트의 표 기반 사례로 함께 증명합니다.

### UAT-15 확장 설치와 실제 사용

- Registry에서 공식 최소 확장을 검색합니다.
- Capability·권한을 읽고 설치 승인합니다.
- healthy 상태 뒤 해당 Tool이 필요한 Work를 실행합니다.

통과: 설치된 Capability가 화면에 보이고 실제 tool-call·approval·audit·Work 결과에 연결됩니다.

### UAT-16 설정과 로컬 운영 상태

- Provider·route·계정·quota·`review | automatic | full-access` 자율성·daemon·DB 버전·데이터 위치를 확인합니다.

통과: 실제 값이 표시되고 secret은 없으며 읽기 실패를 숫자 0으로 위장하지 않습니다.

## 7. 전체 권한 필수 시나리오 2개

두 시나리오는 실제 개인 데이터가 없는 격리된 macOS 테스트 계정, 임시 Workspace와 그 형제 임시 디렉토리에서만 실행합니다. 제품이 현재 연결기에 전체 권한을 전달하지 못하면 제한됨으로 표시하는 것은 정직한 진단이지만 출시 통과는 아닙니다.

### UAT-P01 전체 권한 활성화와 실행

- 기본 실행 정책이 `automatic`이고 일반 Workspace 경계가 적용되는지 확인합니다.
- 설정에서 `전체 권한`을 선택하고 [전체 권한 설계](2026-07-25-full-access-permission-design.md)의 사용자 책임 문구가 정확히 한 번 나타나는지 확인한 뒤 승인합니다.
- 실제 Work가 Workspace의 형제 임시 디렉토리에서 marker 파일을 읽고 새 파일을 만든 뒤 그 새 파일만 삭제하게 합니다.
- 같은 Work가 하위 프로세스를 실행하고 임시 로컬 HTTP server에 요청하며 설치된 최소 Tool·MCP·Extension 중 제품에 연결된 하나를 호출하게 합니다.
- Codex·Claude 번들 연결기의 capability 상태와 실제 선택된 실행기의 mode revision을 로그·read-only query로 대조합니다.

통과: 현재 macOS 사용자가 허용한 범위에서 파일 읽기·쓰기·삭제, 프로세스·네트워크·연결된 도구 호출이 성공하고 행동별 승인 팝업이나 수신함 승인 항목이 생기지 않습니다. Work·Execution·Tool 사건에는 `full-access`와 같은 revision이 남고, 지원하지 않는 실행기를 전체 권한으로 거짓 표시하지 않습니다.

### UAT-P02 전체 권한 지속·회수와 Growth

- 전체 권한 상태에서 앱과 daemon을 다시 시작하고 추가 경고 없이 같은 mode revision이 복원되는지 확인합니다.
- 일반 모드에서 Policy·Governance 승인을 요구하도록 만든 실제 완료 Work의 적격 Growth 후보 하나를 전체 권한에서 별도 승인 없이 반영하고 다음 Work가 새 target version을 사용하는지 확인합니다. Prompt·Memory·Policy·Organization 네 target의 동일 동작은 표 기반 제품 테스트와 대조합니다.
- 후보의 source·evaluation·checksum·EffectContract와 적용 이력을 열고, 부적격 후보가 전체 권한에서도 채택되지 않는지 확인합니다.
- 실행 중 전체 권한을 끄고 활성 세션이 중단되는지 확인합니다. `review`로 바꾼 뒤 새 위험 행동이 UAT-09와 같은 승인 대기를 만드는지 확인합니다.
- 전체 권한을 다시 켤 때 사용자 책임 경고가 정확히 한 번 나타나고, 확인 뒤 행동별 추가 승인은 생기지 않는지 확인합니다. 이어서 격리 실행에서 긴급 정지를 실행하고 이후 부작용이 생기지 않는지 확인합니다.

통과: 전체 권한은 재시작 뒤 유지되고 Growth 승인을 생략하지만 평가·효과·되돌리기 계보는 남습니다. 해제 즉시 이후 행동이 일반 정책으로 돌아오고 긴급 정지가 실제 실행을 멈춥니다.

## 8. 지식·기억 필수 시나리오 4개

### UAT-K01 Workspace 색인·코드 관계·citation

- cross-file 호출 관계가 있는 작은 fixture 파일 두 개를 trusted Workspace에 둡니다. 검색 root 파일에만 고유 marker를 넣고 target 파일에는 그 marker를 넣지 않습니다.
- 파일을 개별 첨부하지 않고 Workspace 전체 문맥에서 고유 marker를 요청해 실제 Provider Work를 실행합니다.
- Work의 `사용한 지식`과 Core Office 공유 출처를 열어 검색 root와 graph로만 도달 가능한 관련 1-hop symbol, line range를 확인합니다.
- read-only query로 EvidenceBrief와 Representative·Strategy·Delivery execution의 citation checksum을 대조합니다.

통과: target 파일에 검색 marker가 없는데도 resolved relation을 통해 Brief에 포함되고, 같은 IndexVersion의 citation을 실제 세 Agent 입력과 화면이 가리킵니다.

### UAT-K02 경로 경계·manifest 변경·stale 처리

- Workspace 안 허용 파일 하나만 첨부하고, 유사한 문자열이 든 비첨부 파일도 함께 둡니다.
- 첫 Work 뒤 허용 파일을 수정하고 두 번째 Work를 시작합니다.
- 첫 Work의 Brief가 과거 snapshot을 유지하면서 stale로 판정되는지, 두 번째 Work가 새 IndexVersion을 쓰는지 확인합니다.
- 비첨부 파일이 검색, 1-hop graph, prompt, 화면 어디에도 나오지 않는지 확인합니다.

통과: manifest 미변경 시 index가 재사용되고 변경 시 새 version이 생기며, stale 상태를 숨기지 않고 첨부 allowlist 밖 source가 유출되지 않습니다.

### UAT-K03 개인 기억 저장·재시작·새 Work 적용

- 개선의 `내 기억`에 민감하지 않은 fixture preference를 저장합니다.
- 앱과 daemon을 정상 종료한 뒤 다시 실행합니다.
- 새 Work를 만들고 화면 안내, PromptVersion, RuntimeExecution `memory_version_ids`, 실제 Agent 응답을 확인합니다.

통과: 재시작 뒤 기억이 남고 저장 이후 만든 Work만 해당 MemoryVersion을 사용하며, 기억 원문이나 개인 식별 정보가 로그·증거에 노출되지 않습니다.

### UAT-K04 앞으로 사용하지 않음과 과거 계보 보존

- UAT-K03 기억을 사용한 Work의 PromptVersion·RuntimeExecution ID를 기록합니다.
- `앞으로 사용하지 않음`을 실행하고 새 Work를 만듭니다.
- 앞 Work와 새 Work의 memory lineage를 비교합니다.

통과: 새 Work에는 해당 key가 없고 앞 Work의 PromptVersion·Records·checksum은 변하지 않으며 UI가 hard delete로 오해시키지 않습니다.

## 9. 실패 처리 루프

```text
실제 시나리오 실패
→ 화면·로그·query로 최초 어긋난 경계 확인
→ 가장 낮은 공통 계층에 재현 테스트 1개
→ 같은 공통 경로 최소 패치
→ 재현 테스트
→ 실패한 UAT
→ 인접 표적 테스트
→ 조각 커밋과 증거 기록
```

시각 불량은 먼저 스크린샷과 실제 치수로 재현합니다. 순수 스타일 문제에 서비스 유닛 테스트를 만들지 않습니다. 상태·계보·클릭 대상 같은 구조가 원인이면 기존 통합 테스트에 한 건만 추가합니다.

## 10. 조각별 게이트와 최종 게이트

조각 중에는 변경 영역의 typecheck·표적 test만 실행합니다. 단계 종료 때 해당 패키지 전체 test를 실행합니다. 최종 후보에서만 다음을 한 번 실행합니다.

```sh
pnpm verify
pnpm --filter @massion/desktop tauri:build
```

`pnpm verify:release`는 현재 레거시 CLI·TUI·Web 묶음을 검사하므로 개인용 데스크톱 완료 근거로 사용하지 않습니다. 그 뒤 같은 SHA에서 서명·공증한 `.app`으로 UAT-01~16, UAT-K01~K04, UAT-G01~G02와 UAT-P01~P02를 다시 실행합니다. 최소 출시 판정은 핵심 12개, 지식·기억 4개, 지속 발전 2개, 전체 권한 2개와 구현 완료된 조직·확장·설정 시나리오 전부 통과입니다.

추가로 깨끗한 macOS arm64 환경에서 설치·후보 교체 업데이트·제거·재설치 뒤 데이터 지속성과 daemon·SurrealDB sidecar 강제 종료 복구를 확인합니다. 키보드만으로 핵심 흐름을 완주하고 VoiceOver와 Accessibility Inspector로 각 화면의 이름·역할·상태·초점 순서를 실측합니다.

## 11. 중단 조건

- 데이터 손실 또는 tenant 경계 위반
- secret 노출
- `full-access`가 아닌 모드의 승인 우회 또는 어느 모드에서든 Assurance 우회
- 동일 command의 중복 부작용
- Work·run·message 인과 계보 유실
- EvidenceBrief·citation 또는 PromptVersion·MemoryVersion 계보 불일치
- 앱 재시작 후 상태 복원 실패

이 중 하나가 나오면 다음 시나리오로 진행하지 않고 원인 테스트와 패치를 먼저 닫습니다. 일반적인 문구·간격 문제는 현재 시나리오 묶음이 끝난 뒤 함께 조정합니다.
