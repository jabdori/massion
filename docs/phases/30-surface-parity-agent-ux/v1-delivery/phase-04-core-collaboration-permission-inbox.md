# 페이즈 04 — Core·협업·조직·개선·권한·수신함 정합화

> **상태:** 코드·실제 Tauri 증분 검증 완료, 전체 UAT·효과 게이트 대기
> **시작 기준:** 페이즈 03의 코드 근거 Work 연결 완료
> **다음 게이트:** 전체 원자 데스크톱 UAT 10종 이상, 긴급 정지·업데이트·효과 cohort

## 목표

Core 파이프라인, 권한 모드, 수신함 UX, 메모리 주입 경로가 실제 제품 조립(product.ts)과 데스크톱 UI에서 정합성을 갖추도록 연결한다.

## 단계

| 단계 | 현재 범위 | 상태 |
|---|---|---|
| 04-1 | 코드 근거를 Work와 Agent 실행에 연결 (Task 3) | 코드 검증 완료 |
| 04-2 | 전체 권한 실행 모드 추가 | 코드·실제 bundled 앱 전환 검증 완료 — 긴급 정지·전체 원자 UAT는 남음 |
| 04-3 | 메모리 주입 경로 연결 | Work Prompt/Runtime 계보와 실제 memory put/forget·Growth 실행 검증 완료 — 효과 cohort는 남음 |
| 04-4 | 수신함 UX 정합 (지도 비율) | 코드 검증 완료 |
| 04-5 | 전체 빌드 + 데스크톱 UAT | 부분 통과 — Core UAT-01·02·03·07·12 및 재시작 보존 |

## 완료 근거 기록

### 04-1 — 코드 근거를 Work와 Agent 실행에 연결

- `138414f36` — Evidence 지식 계층을 Core 파이프라인과 데스크톱에 연결.

### 04-2 — 전체 권한 실행 모드 추가

- `e746202d4` — 거버넌스 자율성 모드에 전체 권한(레벨 3) 저장을 추가.
- `123fb1bf0` — 데스크톱 설정 화면에 "전체 권한" 버튼과 설명문 추가.
- 현재 후보 변경 — 저장 값을 정본 `full-access`로 정규화하고, 구독 정책 resolver가 `danger-full-access`, `never`, 네트워크 허용, 자율성 revision을 반환하도록 연결했습니다. Codex SDK와 Claude Agent SDK는 각각 `danger-full-access`와 `bypassPermissions + allowDangerouslySkipPermissions`를 전달하며 Claude의 Massion sandbox·permission hook은 전체 권한에서 생략합니다.

현재 전체 권한은 tenant·멱등성 검증 뒤 Governance 정책·승인과 활성 정책 부재를 우회하고 실행기 option까지 전달합니다. Work·Runtime의 mode/revision 계보와 해제 전파는 구현됐고, 후보 `e3b5fe883` 실제 bundled 앱에서 `automatic→full-access→automatic` 및 `runtimePermissionStatus`를 확인했습니다. 긴급 정지·전체 P01/P02 UAT는 남아 있습니다.

### 04-3 — 메모리 주입 경로 연결

- `60bfcda94` — GrowthWorkPromptAdapter를 WorkService.create의 promptVersions 자리에 주입.

`70e255ca4`가 onboarding 시점 PromptDefinitionVersion 시드를 보완했습니다. `GrowthWorker`는 완료된 Records를 backfill·claim하고 WorkRecord·Verification·Assurance·event·artifact를 redaction된 bounded snapshot으로 묶어 실제 `planning-quality` structured 실행과 Reflection 저장까지 연결합니다. 현재 후보별 target checksum·독립 Assurance signal·Evaluation과 기존 Adoption 호출까지 연결됐지만 효과 표본·degraded 복원·명시적 memory conflict는 아직 남아 있어 지속 발전 생산 루프 완료를 뜻하지 않습니다.

### Growth Reflection 생산 연결 증분

- 서버의 throw-only Reflection adapter를 실제 routed runner·source verifier·runtime verifier로 교체했습니다.
- 로컬 bootstrap 뒤 worker timer를 시작하고 daemon drain에서 worker를 먼저 닫도록 연결했습니다.
- 실제 provider 출력 검증 실패가 background rejection으로 daemon을 종료시키지 않도록 worker tick 경계를 격리했습니다.
- 후보 `e3b5fe883` 실제 Work에서 Growth execution이 `succeeded`했고, `growth.configuration.get`·suggestions·memories를 조회했습니다. 후속 후보 `40a6ffbc8`에서는 workspace 디렉터리 문맥 Work와 첨부 경계 검증도 실제 bundled 앱에서 확인했습니다. 최신 후보 `573297642`에서는 실제 Provider Work·Growth 조회·기억 및 재시작 보존을 다시 확인했지만 effect cohort 최소 조건 미달과 전체 채택·복원 UAT는 남아 있습니다. [최신 Provider·재시작 증거](../../../evidence/phase-30/desktop-live-provider-restart-uat-2026-07-27-573297642.md)

### 04-4 — 수신함 UX 정합

- `123fb1bf0` — 조직 화면 그리드 비율을 11:9에서 1:1(50:50)로 변경.

### 실제 Core UAT 증분

- `7708d5f33` — 실제 Provider Work에서 확인한 VoltAgent 위임의 Prompt section handle 불일치를 수정하고 회귀 사례를 고정했습니다.
- [실제 Core UAT 증거](../../../evidence/phase-30/desktop-core-uat-2026-07-26.md) — 같은 수정 커밋의 Tauri 번들에서 Provider 연결, workspace 없는 Work, 협업·Assurance·Records, 재시작 보존을 확인했습니다.

### 실제 Work 오류 가시성 증분

최신 릴리스 번들에서 실제 Provider Work가 `context-strategy` 단계에서 막히는 상황을 Computer Use로 확인했습니다. 기존에는 수신함의 내부 reason만으로 표시되던 실패를 중앙 대화에도 연결해 다음 정보를 함께 보여줍니다.

- 실행 상태: `실행이 멈췄습니다`
- 사용자 설명: Provider가 전략 계획의 구조화 응답을 완성하지 못했다는 원인
- 현재 단계: `맥락·전략 구성`
- 조치 안내: 상단 `실행 재개`로 같은 단계부터 재시도

재개 클릭 후에도 실제 Provider 구조화 응답 실패가 반복되어, 이번 변경은 오류 가시성·재개 연결을 닫은 것이며 Provider 호환성 해결이나 Core Work 완료를 의미하지 않습니다. 상세 실행 ID와 번들 해시는 [실제 증거 기록](../../../evidence/phase-30/emergency-release-flow-2026-07-27.md)에 남겼습니다.

### Provider capability·fallback·로컬 runtime 증분

사용자 모델의 Provider capability를 Model Builder까지 전달하고, 구조화 출력 파싱 실패를 `output` 실패로 분류해 다른 Model Candidate로 fallback하도록 연결했습니다. 번들 SurrealDB는 사용자 data directory의 검증된 runtime 경계로 복사한 뒤 실행합니다.

최신 후보 `f23380048e`를 실제 Tauri와 격리된 OpenRouter 프로필에서 실행해 Work `caba29fc-0eda-4199-8769-f116da511bf9` / Run `b4fca03d-aa2c-4c38-9e2c-8b0e02f6d8f8`가 `terminal·completed`에 도달하고 작업 `1/1·100%`임을 확인했습니다. 이 실행에서는 모든 Provider 호출이 성공해 실제 fallback 전이는 없었으며, 동일 Credential의 다른 Model fallback은 `router` focused 회귀 테스트로 고정했습니다. Growth 후속 실행의 `unknown` 실패와 전체 Provider 모델 편차는 남은 범위입니다. 상세 증거는 [Provider capability·fallback·runtime 증분](../../../evidence/phase-30/emergency-release-flow-2026-07-27.md)에 기록했습니다.

### 04-5 — 전체 빌드 + 데스크톱 UAT

후보 `40a6ffbc8`에서 실제 Tauri·Provider·workspace 파일·디렉터리 문맥·Knowledge·Growth·full-access·재시작 증분을 확인했고, 최신 후보 `573297642`에서 Provider Work·Knowledge·Memory·Growth 조회·재시작 보존을 재확인했습니다. 이번 후보 `f23380048e`에서는 실제 OpenRouter Work 완료와 bundled SurrealDB self-start를 추가 확인했습니다. 전체 원자 UAT, native picker 완료, 평가·채택·효과·복원, 서명·공증·설치 게이트는 남아 있으므로 04-5와 개인용 v1 완료를 전체 통과로 표시하지 않습니다. [workspace 경계 증거](../../../evidence/phase-30/desktop-live-workspace-directory-uat-2026-07-26-40a6ffbc8.md) · [최신 Provider·재시작 증거](../../../evidence/phase-30/desktop-live-provider-restart-uat-2026-07-27-573297642.md)
