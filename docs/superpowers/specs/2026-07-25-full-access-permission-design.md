# 개인용 전체 권한 실행 설계

> **상태:** 사용자 승인 설계
> **작성일:** 2026-07-25
> **대상:** 개인용 macOS v1
> **결정 기록:** [ADR-001](../../architecture/ADR-001-personal-full-access.md)
> **목표:** 사용자가 자기 Mac과 자기 Provider 계정으로 실행하는 Massion에 Codex·Claude Code의 위험 우회 모드와 같은 명시적 전체 권한 선택지를 제공합니다.

## 1. 결정

조직 실행 자율성은 다음 세 모드입니다.

| 화면 이름 | 저장 값 | 기본값 | 승인과 실행 경계 |
|---|---|---:|---|
| 검토 | `review` | 아니요 | 읽기가 아닌 행동에 사용자 승인을 추가하며 정책·Workspace 경계를 유지 |
| 자동 | `automatic` | 예 | 정책이 허용한 행동을 자동 실행하되 정책 거부·필수 승인·Workspace 경계를 유지 |
| 전체 권한 | `full-access` | 명시적 선택만 | Massion 승인·Governance 권한 거부·승인 요구·Workspace 실행 샌드박스를 우회하고 현재 macOS 사용자 권한으로 실행 |

`automatic`을 `full-access`로 재해석하지 않습니다. 기존 자동형의 안전 경계를 보존하고 별도 선택지를 추가해야 설정 문구와 실제 동작이 일치합니다.

개선 채택 방식인 Growth `review | auto`는 별도 설정입니다. 전체 권한이 아니면 기존 Growth 설정과 Governance 중 더 엄격한 결과가 적용됩니다. 전체 권한에서는 Growth의 유효 채택 방식이 `auto`가 되어 Prompt·Memory·Policy·Organization 네 대상의 적격 후보를 별도 승인 없이 반영합니다.

## 2. 사용자가 허용하는 범위

전체 권한을 켜면 에이전트와 실행기가 다음 행동을 Massion의 행동별 승인 없이 수행할 수 있습니다.

- 선택한 Workspace 밖을 포함해 현재 macOS 사용자가 접근 가능한 파일 읽기·생성·수정·이동·삭제
- 셸 명령과 하위 프로세스 실행
- 네트워크 요청과 로컬 포트·Unix socket 사용
- 설치되어 실행기에 노출된 Tool·MCP·Extension의 호출
- 제품에 연결된 사용자 소유 Provider·계정의 모델 호출과 그에 따른 사용량·비용 발생
- 조직·Prompt·Policy·Memory 변경과 Extension 설치·활성화처럼 기존 정책이 승인 대상으로 분류한 제품 행동

전체 권한은 권한 검사 우회이지 능력 생성 기능이 아닙니다. 설치되지 않은 도구, 노출되지 않은 명령, Provider가 거부한 요청, macOS 사용자가 접근할 수 없는 자원은 여전히 사용할 수 없습니다.

## 3. 한 번의 경고와 회수

설정에서 `전체 권한`을 선택하면 다음 문구를 확인 대화상자에 그대로 보여줍니다.

> 에이전트가 현재 macOS 사용자와 같은 범위에서 파일을 읽고 변경·삭제하며, 명령과 네트워크 요청을 실행하고 연결된 계정과 확장을 사용할 수 있습니다. 그 결과에 대한 책임은 사용자에게 있습니다.

동작 규칙은 다음과 같습니다.

1. `review` 또는 `automatic`에서 `full-access`로 들어갈 때마다 한 번 확인합니다.
2. 확인 뒤에는 파일·명령·네트워크·도구별 추가 확인을 띄우지 않습니다.
3. 앱과 daemon을 재시작해도 선택을 유지하고 다시 확인하지 않습니다.
4. 사용자가 전체 권한을 끄면 활성 실행 세션을 중단한 뒤 이후 행동부터 새 모드를 적용합니다.
5. 긴급 정지는 어느 모드에서도 사용자가 즉시 실행할 수 있습니다.

모드 변경과 긴급 정지 명령은 데스크톱의 사용자 제어 경로만 사용하며 Agent tool catalog에는 넣지 않습니다. 전체 권한은 이미 노출된 능력의 승인 경계를 없애는 모드이지 제품 제어권을 에이전트 기능으로 추가하는 모드가 아닙니다.

## 4. 권한과 정확성의 경계

전체 권한에서 우회하는 것과 유지하는 것을 분리합니다.

| 구분 | 전체 권한 동작 |
|---|---|
| Massion 행동별 승인 | 우회 |
| 활성 정책의 권한 deny·approval requirement | 우회 |
| Workspace trust·allowlist·symlink의 실행 제한 | 우회 |
| Connector 파일·명령·네트워크 sandbox | 우회 |
| Provider 사용량·비용별 승인 | 우회 |
| macOS 계정·ACL·SIP·Keychain 제한 | 유지 |
| Provider·모델 자체 거부와 할당량 | 유지 |
| tenant identity와 요청의 organization 일치 | 유지 |
| schema·revision·checksum·CAS·멱등성 | 유지 |
| Work 완료 기준·Assurance·Records 계보 | 유지 |
| Growth 독립 평가·효과 측정·노출 중단·되돌리기 | 유지 |

사용자가 에이전트에게 일반 Work로 직접 변경을 지시하면 전체 권한으로 실행할 수 있습니다. 시스템이 과거 경험에서 스스로 만든 Growth 후보는 별도 승인을 생략하더라도 후보·평가·효과 계보를 계속 거칩니다. 이는 권한 제한이 아니라 잘못된 상태와 손상된 학습을 막는 제품 정확성 계약입니다.

전체 권한에서도 정상 제품 경로의 Audit·Execution·Tool·Artifact 사건은 기록합니다. 그러나 비격리 프로세스가 로컬 데이터 파일 자체를 변경할 수 있으므로 이 모드에서 감사 기록의 외부 변조 방지를 보장하지 않습니다.

## 5. 저장 계약

기존 `AutonomyMode = "automatic" | "review"`에 `"full-access"`를 추가합니다. 과거 migration을 수정하지 않고 추가 migration으로 `governance_autonomy.mode`의 허용 값을 넓힙니다.

```ts
type AutonomyMode = "automatic" | "review" | "full-access";

interface AutonomyState {
  readonly mode: AutonomyMode;
  readonly revision: number;
}
```

- 새 개인 조직의 기본값은 기존과 같은 `automatic`입니다.
- 변경은 owner 사용자만 현재 revision과 비교 후 교환(CAS)으로 수행합니다.
- 확인 대화상자 승인 여부를 별도 영구 토큰으로 만들지 않습니다. `full-access` 저장 명령 자체가 확인 결과이며 한 번의 감사 사건을 남깁니다.
- Work와 RuntimeExecution에는 실행을 시작한 모드와 revision을 기록해 사후 설명에 사용합니다.
- 실제 부작용 직전에는 현재 mode revision을 다시 읽습니다. 실행 시작 snapshot만 믿지 않으므로 사용자가 모드를 끈 뒤 새 부작용이 이전 전체 권한으로 진행되지 않습니다.

전체 권한을 켤 때 이미 `awaiting-approval`인 실행은 한 번 재평가합니다. 승인만 남은 항목은 같은 command ID로 재개하고, 실제 입력 오류·Provider 실패·없는 Capability처럼 권한과 무관한 차단은 그대로 유지합니다.

## 6. Governance 판단

현재 공통 판단 지점인 `GovernanceService.evaluate()`에서 모드를 적용합니다.

```text
tenant 문맥과 입력 형식 검증
→ 현재 AutonomyState 조회
→ full-access이면 approval·Cedar 권한 거부를 우회한 allow 결정 기록
→ 그 외에는 기존 활성 Policy·불변식·review 조임 적용
```

전체 권한 결정도 `decisionId`, `commandId`, 요청 hash, autonomy mode·revision과 `full-access-user-opt-in` 이유를 기록합니다. 같은 command ID에 다른 요청을 쓰지 못하는 기존 멱등 검사는 유지합니다.

데이터를 다른 조직인 것처럼 읽거나 쓰게 만드는 tenant 불일치는 권한 문제가 아니라 요청 정합성 오류이므로 우회하지 않습니다. 개인용 v1의 로컬 조직 하나를 전제로 하되 이 검사를 삭제하지 않습니다.

## 7. 실행기 전달

`SubscriptionAgentPolicyResolver`가 현재 자율성 상태를 읽고 다음 유효 실행 정책을 만듭니다.

```ts
interface SubscriptionAgentExecutionPolicy {
  readonly permissionMode: "governed" | "full-access";
  readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "never" | "on-request" | "deny";
  readonly networkAccessEnabled: boolean;
  readonly autonomyRevision: number;
}
```

전체 권한의 값은 `permissionMode: "full-access"`, `sandboxMode: "danger-full-access"`, `approvalPolicy: "never"`, `networkAccessEnabled: true`입니다. Workspace는 작업 디렉토리와 지식 문맥을 정하는 값으로 계속 전달하지만 쓰기 보안 경계로 사용하지 않습니다.

연결기별 전달은 다음 한 군데에서 수행합니다.

| 실행기 | 전체 권한 전달 |
|---|---|
| Codex SDK/CLI | `sandboxMode: "danger-full-access"`, `approvalPolicy: "never"`, network 활성. 현재 CLI의 `--dangerously-bypass-approvals-and-sandbox`와 같은 의미 |
| Claude Agent SDK/CLI | `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`, SDK sandbox 미설정. 현재 CLI의 `--dangerously-skip-permissions`와 같은 의미 |
| 내장 Tool·MCP·Extension | Governance permission bridge의 행동별 prompt를 생략하고 daemon 프로세스의 OS 권한으로 호출 |

Codex·Claude의 실제 지원 옵션은 번들 버전의 타입과 시작 시 capability probe로 확인합니다. 연결기가 전체 권한을 정확히 표현하지 못하면 더 제한된 모드로 조용히 가장하지 않고 실행 상태를 `limited`로 표시하며 구체적인 미지원 이유를 반환합니다. 이 실패 때문에 Massion 승인 팝업을 다시 만들지는 않습니다.

Renderer에는 daemon token, shell, filesystem API를 주지 않습니다. 전체 권한은 daemon과 그 하위 실행기의 정책이며 React 화면에 범용 실행 권한을 주는 설계가 아닙니다.

## 8. Growth·지식·기억

- Growth 설정의 기본값은 계속 `review`입니다.
- 일반 모드에서는 Growth `review | auto`와 Governance 중 더 엄격한 결과를 사용합니다.
- 전체 권한에서는 네 target의 적격 후보와 검증된 `degraded` 복원을 Policy·Governance 권한 판단과 승인 없이 수행하고 수신함 승인 항목을 만들지 않습니다.
- `model-self` 하나뿐인 후보, stale source·target, checksum 충돌, 명시적 사용자 기억과 충돌하는 후보는 권한과 무관한 부적격이므로 반영하지 않습니다.
- 선택한 Workspace·첨부 파일만 자동 색인합니다. 전체 권한을 켰다는 이유로 홈 디렉토리나 다른 프로젝트를 RAG에 넣지 않습니다.

## 9. 설정·수신함·상태 표시

설정의 실행 정책 블록에 세 선택지를 한 줄 설명과 함께 표시합니다. `전체 권한`은 경고색 이름만으로 공포를 반복하지 않고 현재 활성 상태를 명확히 보여줍니다.

- 활성 문구: `전체 권한 켜짐 · 현재 macOS 사용자 권한으로 실행`
- 연결기 상태: `전체 권한`, `제한됨` 또는 `사용 불가`
- 끄기 행동: `전체 권한 끄기`

전체 권한이 허용하는 행동에는 승인 대기 수신함 항목을 만들지 않습니다. 실제 OS·Provider·Capability 실패는 승인 대기가 아니라 원인과 재시도 조건이 있는 `차단`으로 표시합니다. 모드 전환 직전부터 존재한 승인 항목은 재평가가 끝나면 같은 전역 Inbox projection에서 제거합니다.

## 10. 최소 검사와 실제 앱 UAT

사전 단위 테스트를 행동마다 만들지 않습니다. 다음 경계만 표 기반 통합 테스트로 고정합니다.

1. `review | automatic | full-access`가 동일한 위험 행동에 각각 승인 추가·기존 정책 유지·승인 우회를 반환하고 mode revision을 기록합니다.
2. 전체 권한에서도 tenant 불일치, stale revision, checksum 오류와 중복 command의 다른 payload가 거부됩니다.
3. Codex와 Claude factory가 전체 권한 정책을 각 실행기의 실제 옵션으로 한 번씩 전달합니다.
4. Growth 네 target이 전체 권한에서 별도 승인 없이 반영되지만 부적격 후보와 잘못된 효과 표본은 거부됩니다.

실제 Tauri 앱에서는 [UAT-P01](2026-07-24-desktop-live-uat-design.md#uat-p01-전체-권한-활성화와-실행)과 [UAT-P02](2026-07-24-desktop-live-uat-design.md#uat-p02-전체-권한-지속회수와-growth)을 전부 통과해야 합니다. 파일 삭제는 격리된 테스트 계정의 임시 fixture만 사용합니다.

## 11. v1에서 하지 않는 것

- 행동별 권한 행렬과 사용자 정의 규칙 편집기
- 시간 제한 전체 권한, 일정별 자동 전환, 여러 preset
- macOS root 권한 요청이나 시스템 무결성 보호(SIP)·투명성 및 동의 제어(TCC) 우회
- 전체 홈 디렉토리 자동 색인
- 원격 팀 조직에 전체 권한을 전파하는 기능
- 외부 비격리 프로세스에 대한 감사 기록 변조 방지 보장

## 12. 완료 판정

- [ ] 기본 `automatic`과 Growth 기본 `review`가 유지됩니다.
- [ ] 전체 권한 진입 때 정확한 경고를 한 번 확인하고 재시작 뒤 유지됩니다.
- [ ] Massion 승인, Governance 권한 거부·승인 요구와 Workspace 실행 sandbox가 전체 권한에서 실제로 우회됩니다.
- [ ] Codex·Claude·내장 Tool 경로가 거짓 `full-access` 상태 없이 같은 유효 모드를 사용합니다.
- [ ] Workspace 밖 임시 파일 읽기·쓰기·삭제, 프로세스·네트워크·Tool 호출이 승인 항목 없이 동작합니다.
- [ ] 전체 권한 해제와 긴급 정지가 실제 실행을 회수합니다.
- [ ] Growth 네 target은 승인 없이 적용되며 평가·checksum·효과·되돌리기 계보는 남습니다.
- [ ] UAT-P01~P02와 인접 핵심 UAT가 실제 서명 후보 앱에서 통과합니다.
