# 개인용 데스크톱 후보 릴리스 gate — 진행 중

> 이 문서는 공개 릴리스나 개인용 v1 완료 증거가 아닙니다. 현재 제품 후보에서 실제 Tauri 증분 결과와 남은 차단 조건을 한 곳에 모은 gate 입력입니다.

<!-- desktop-uat-evidence: actual-tauri -->
<!-- desktop-release-candidate-sha: 573297642a41088a662aa58690ca16f2a43e84b6 -->

## 현재 후보

- 제품 후보 SHA: `573297642a41088a662aa58690ca16f2a43e84b6`
- Bundle: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- 실제 Tauri·Provider·workspace·재시작 증분: [기존 Tauri/API 증거](./desktop-live-tauri-uat-2026-07-26-e3b5fe883.md)
- 최신 native folder/file panel 증분: [제품 후보 증거](./desktop-live-native-file-panel-uat-2026-07-26-573297642.md)

## 릴리스 gate 상태

| gate | 상태 | 근거 또는 차단 조건 |
| --- | --- | --- |
| 실제 Tauri 23개 원자 UAT | 미완료 | native file 선택 완료와 전체 시나리오 실행이 남아 있음 |
| Provider·지식·기억·Growth·전체 권한 | 증분 확인 | 동일 후보의 실제 API 증거는 있으나 전체 화면 UAT와 Growth effect cohort가 남아 있음 |
| Developer ID 서명·공증·sidecar 서명 | 미완료 | Developer ID와 Apple credential이 필요함. ad-hoc은 통과로 인정하지 않음 |
| 깨끗한 설치·업데이트·제거·재설치 | 미실행 | 서명 후보가 먼저 필요함 |
| 비정상 종료·접근성·BYOK 경계 | 미실행 | 실제 signed candidate에서 실측해야 함 |
| 공개 GitHub Release | 만들지 않음 | 수동 workflow는 비공개 Actions artifact만 보관함 |

이 문서에는 23개 UAT 통과 marker를 의도적으로 기록하지 않았습니다. `scripts/verify-desktop-release.mjs`는 필수 marker가 없으면 실패해야 하며, 하나라도 건너뛴 후보를 릴리스로 승격하지 않습니다.
