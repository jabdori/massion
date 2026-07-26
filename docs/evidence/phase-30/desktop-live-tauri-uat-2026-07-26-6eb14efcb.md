# Phase 30 실제 Tauri·Provider 통합 증분 UAT — `6eb14efcb`

> 이 기록은 후보 SHA의 실제 로컬 Tauri 실행과 API 관측을 남깁니다. 23개 전체 원자 UAT, 서명·공증, 공개 릴리스 완료를 주장하지 않습니다.

## 실행 경계

- 후보 SHA: `6eb14efcb` (코드 경계는 직전 `ca6096b47`와 동일하며 문서 커밋을 포함)
- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion V1 Candidate.app`
- 실행: Tauri executable → bundled desktop bridge/server → 격리된 local SurrealDB 3.2.1
- 데이터: `/tmp/massion-growth-gate-uat-20260726` 격리 프로필을 재사용했습니다. 사용자 경로·토큰은 기록하지 않았습니다.

## 실제 관측

| 시나리오 | 결과 |
| --- | --- |
| 동일 후보 Tauri 패키징 | `cargo tauri build --bundles app` 성공 |
| 실제 화면 | `massion-desktop` 프로세스와 `Massion V1 Candidate` 창을 확인하고 화면 캡처 `/tmp/massion-tauri-ca6096-screen-front.png`를 저장 |
| 준비 상태·재시작 | `/health/ready=ready`, 재시작 후 동일 상태·SurrealDB 3.2.1 |
| 실제 Provider Work | `workspace.register` → `workspace.trust` → `run.start`에서 README 파일 범위를 지정; Work가 `completed`, representative/context-strategy/assurance/growth를 포함한 5개 실행이 모두 `succeeded` |
| 파일·workspace context | 실제 workspace의 `README.md`를 등록·신뢰하고 `workspacePaths=["README.md"]`로 실행 |
| Knowledge/RAG | `work.knowledge=ready`, README chunk reference 2개와 fresh index/evidence brief 반환 |
| Growth | `growth.configuration.get`이 reflection enabled·auto·version 2 반환; Reflection 후 18개 suggestion이 저장됨; 현재 effect evaluation은 cohort 최소 3건 전이라 0건이며 이를 성공으로 세지 않음 |
| 전체 권한 | `automatic(revision 8) → full-access(revision 9) → automatic(revision 10)`, 회수 후 runtime permission은 governed |
| 기억 | explicit memory put `revision 5→6`, forget `6→7`; 최종 active key는 기존 `response.format`만 남음 |
| 조직·수신함 | organization graph snapshot은 8 persistent nodes 반환; pending approval inbox는 0건 |
| 재시작 보존 | 같은 번들을 종료·재실행한 뒤 trusted workspace 2개, Work 목록 11개, Growth version 2, memory revision 7을 재조회 |

## 제한과 미완료

- Computer Use 런타임은 `@oai/cdp-browser-backend` 누락으로 초기화되지 않았습니다. 화면 확인은 macOS 캡처와 visible `massion-desktop` 프로세스로 보완했지만 Computer Use 성공으로 주장하지 않습니다.
- 실제 product 통합 테스트에는 ApplicationRun recovery·control plane/Core snapshot·Software Engineering fixture 관련 실패 5건이 남아 있어 전체 후보 게이트는 미통과입니다.
- 23개 전체 시나리오, native picker OS 대화상자, 업데이트·제거·재설치, Growth 효과 `degraded→revert` cohort 완주, 서명·공증은 실행하지 않았습니다.
- 공개 GitHub Release는 만들지 않았습니다.
