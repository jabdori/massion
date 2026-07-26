# Phase 30 실제 Tauri·Provider 통합 UAT — `f9a639a25120`

> **상태:** 실제 API/sidecar 수직 흐름 통과. Computer Use 화면 조작과 전체 23개 원자 UAT의 완료 증거는 아직 아님.

## 실행 경계

- 후보 SHA: `f9a639a25120` (`fix(application): 명령 입력 오류를 검증 오류로 반환` 포함)
- 빌드: `apps/desktop/src-tauri/target/release/bundle/macos/Massion V1 Candidate.app`
- 실행 경계: 실제 Tauri 앱 → desktop bridge → server → SurrealDB sidecar → 실제 개인 Provider route
- 격리 데이터: 기존 실제 개인 UAT 데이터 루트(문서에는 식별자·토큰·절대 경로를 기록하지 않음)
- Provider secret, 개인 계정 식별자, 전체 파일 경로는 저장·출력하지 않았습니다.

## 실제 통과 시나리오

| ID | 실제 행동 | 관측 |
| --- | --- | --- |
| API-01 | 새 Tauri 후보를 실행하고 local bootstrap·status 조회 | `system.status=ready`, SurrealDB `3.2.1`, model runtime `ready` |
| API-02 | 임시 Workspace 디렉터리 등록 | `workspace.register=succeeded`, 최초 `pending` |
| API-03 | 소유자가 Workspace 신뢰 결정 | `workspace.trust=succeeded`, `trusted`, revision 증가 |
| API-04 | 같은 Workspace를 다시 등록 | 같은 `workspaceId`로 수렴, 중복 Workspace 없음 |
| API-05 | trusted Workspace의 상대 파일 `README.md`를 첨부해 실제 Work 시작 | `run.start=accepted`; 실제 Provider가 intake→context-strategy→evidence→delivery→assurance를 실행 |
| API-06 | Workspace 밖 절대 경로를 파일 첨부로 제출 | `400`, `category=validation`, `operatorCode=APP_COMMAND_VALIDATION`; 500 내부 오류로 위장하지 않음 |
| API-07 | 실제 Provider Work 종결 확인 | Run `completed/terminal`, Work `completed`, 검증 `passed`, artifact·activity·room 보존 |
| API-08 | Work 지식 조회 | `work.knowledge=ready`, 동일 Work 소유의 `README.md` chunk reference 2건과 line range·checksum 반환 |
| API-09 | Work 실행·산출물·검증 조회 | 5개 핵심 실행 성공, 산출물·Assurance evidence·검증 계보가 같은 Work에 연결 |
| API-10 | 전체 권한으로 전환 | `automatic(revision 2)` → `full-access(revision 3)` 성공, 당시 pending approval 3건이 새 실행 intake 없이 제거됨 |
| API-11 | 전체 권한을 automatic으로 회수 | `automatic(revision 4)`, `runtimePermissionStatus=governed`, 긴급 정지 비활성 |
| API-12 | 앱·daemon을 종료하고 같은 후보를 재실행 | 새 bootstrap 뒤 Workspace 1건·`trusted`, Work `completed`, 지식 `ready`, 검증 통과, 실행 원장과 Growth suggestion이 보존 |
| API-13 | 재시작 뒤 자율성 조회 | `automatic`, revision 4, `governed`가 그대로 복원 |
| API-14 | 재시작 뒤 Growth·수신함 조회 | Growth suggestion 5건과 pending approval 0건을 실제 저장소에서 재조회 |
| API-15 | 명시적 개인 기억 저장 후 새 Work 실행 | `growth.memory.put=succeeded`, revision 1; 후속 실제 Provider Work가 `completed`·Assurance 통과 |
| API-16 | 앱·daemon 재시작 후 개인 기억과 후속 Work 조회 | 같은 memory revision 1, `explicit` authority, key 목록과 Work `completed`·지식 `ready`가 복원 |
| API-17 | `앞으로 사용하지 않음`으로 기억 비활성화 | `growth.memory.forget=succeeded`, 새 revision 2가 활성화되고 이전 key는 active entries에서 제거됨 |

## 실제 실패와 수정

초기 동일 후보에서 잘못된 입력 두 가지를 확인했습니다.

1. Workspace 신뢰 결정에 계약 밖 값 `trust`를 보냈습니다. typed 계약 값은 `trusted|blocked`입니다.
2. `workspacePaths`에 절대 경로를 보냈습니다. 계약은 Workspace 루트 기준 상대 경로입니다.

두 요청은 수정 없이 재시도하지 않았습니다. 다만 두 번째 오류가 사용자 입력인데도 HTTP 500 내부 오류로 포장되는 공통 경계를 드러냈습니다. `f9a639a25120`은 `ApplicationCommandRegistry`에서 wire/payload 검증 실패를 `400 APP_COMMAND_VALIDATION`으로 변환하고, 원인·비밀값을 public error에 포함하지 않습니다. 표적 회귀 테스트가 수정 전에 실패한 뒤 통과했습니다.

수정 후 같은 후보의 실제 API 결과는 다음과 같습니다.

```text
invalid file scope: 400 / validation / APP_COMMAND_VALIDATION
valid README scope: 202 / accepted
completed Work: completed / terminal
```

## 아직 완료로 세지 않는 항목

- Computer Use 런타임 초기화가 `@oai/cdp-browser-backend` 누락으로 실패하여 실제 Tauri 화면·native picker·접근성 트리 증거를 만들지 못했습니다.
- 따라서 UAT-01~UAT-16, UAT-K01~K04, UAT-G01~G02, UAT-P01~P02 전체 완료로 표시하지 않습니다.
- full-access에서 실제 파일 생성·삭제, 프로세스·네트워크·Tool 호출을 수행한 P01과 해제 중 실행 중단·긴급 정지를 수행한 P02는 별도 검증이 남아 있습니다.
- 개인 기억의 실제 화면·새 Work에서 memory version ID가 노출되는 UI 계보는 별도 UAT가 남아 있습니다. API 경계에서는 저장·재시작·forget을 통과했습니다.
- 공개 Release는 생성하지 않았고, 기존 공개 `v1.0.0` 제거 상태도 유지합니다.

이 기록은 실제 동일 후보 SHA의 통합 관측을 남기는 문서이며, 화면 UAT 제한을 성공으로 소급하지 않습니다.
