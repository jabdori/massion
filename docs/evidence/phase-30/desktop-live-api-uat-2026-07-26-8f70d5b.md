# Phase 30 실제 Tauri·Provider 통합 UAT — `8f70d5bf31f0`

> **상태:** 동일 후보의 실제 API/sidecar 수직 흐름 통과. 화면 Computer Use와 전체 원자 UAT 완료로는 표시하지 않습니다.

## 후보 경계

- 후보 SHA: `8f70d5bf31f0`
- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion V1 Candidate.app`
- 실행: 실제 Tauri → desktop bridge → server → SurrealDB 3.2.1 → 개인 Z.AI Coding Plan `glm-5.2` route
- 데이터: 앞선 실제 Provider 실행이 남긴 격리 local data를 명시적 삭제 없이 재사용
- secret·token·개인 계정·절대 파일 경로는 이 문서에 기록하지 않았습니다.

## 동일 후보에서 확인한 실제 흐름

| 시나리오 | 관측 |
| --- | --- |
| bootstrap/status | `system.status=ready`, model runtime `ready`, missing/blocked route 없음 |
| Growth 정책 선택 | `growth.configure`로 `review → auto`, configuration version 2; 같은 command ID 재전송은 동일 결과 replay |
| Workspace·파일 문맥 | 기존 trusted Workspace의 상대 `README.md` 첨부로 `run.start=accepted` |
| 실제 Provider Work | Run `completed/terminal`, Work `completed`, automatic autonomy revision 4 |
| 실행 계보 | 4개 실행 모두 `succeeded`; artifact 2개, 독립 검증 `passed` |
| 지식 계보 | `work.knowledge=ready`, 실제 파일 chunk reference 2개와 line/checksum 보존 |
| 전체 권한 전환·회수 | `automatic(revision 4) → full-access(revision 5) → automatic(revision 6)`; 회수 뒤 `runtimePermissionStatus=governed`, pending approval 0건 |
| 기억 적용 Work | memory `revision 3` 저장 후 후속 실제 Provider Work가 `completed`, 4개 실행 성공, 지식·검증 통과 |
| 재시작·보존 | 같은 후보 앱과 daemon을 종료 후 재실행; Growth `auto` version 2, Workspace 1건 `trusted`, Work·지식·검증·실행 원장 복원 |
| 개인 기억 | 재시작 뒤 memory `revision 3`, `response.format` key와 `explicit` 계보가 복원 |
| 입력 경계 | Workspace 밖 경로는 `400 / validation / APP_COMMAND_VALIDATION`으로 반환 |

## 앞선 실제 후보와의 연결

`8f70d5bf31f0`은 입력 오류 경계 수정과 Growth 설정 선택 UI를 포함한 후속 후보입니다. 이 후보 자체에서 Workspace 문맥 Provider Work, Growth auto 설정·replay, full-access 전환·회수, 개인 기억 저장 후 후속 Work, 재시작 보존을 다시 확인했습니다. 기존 격리 데이터의 이전 이력은 새 실행의 입력으로 사용하지 않고 저장소 보존 상태만 read-only로 대조했습니다.

## 완료로 세지 않는 항목

- Computer Use 초기화는 환경의 `@oai/cdp-browser-backend` 누락으로 실패했습니다. 따라서 native picker, 접근성 트리, 실제 화면 클릭 증거는 없습니다.
- UAT-01~UAT-16, UAT-K01~K04, UAT-G01~G02, UAT-P01~P02의 모든 화면·full-access OS 부작용·Growth 효과/복원 검증을 완료했다고 주장하지 않습니다.
- 공개 Release는 만들지 않았습니다. 기존 잘못된 공개 `v1.0.0` 제거 상태를 유지합니다.
