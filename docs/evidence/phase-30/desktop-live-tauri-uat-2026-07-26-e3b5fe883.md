# Phase 30 실제 Tauri·Provider 증분 UAT — `e3b5fe883`

> 이 기록은 동일 후보 SHA에서 실제 Tauri 앱과 bundled bridge/server/SurrealDB를 실행한 증분 증거입니다. 23개 전체 원자 UAT, 서명·공증 또는 공개 릴리스를 완료했다고 주장하지 않습니다.

## 실행 경계

- 후보 SHA: `e3b5fe883954847a2f50f9fec6843a4df525b4bc`
- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- 실행 경계: Tauri 앱 → desktop bridge → Massion server → SurrealDB 3.2.1
- 데이터: 기존 격리 프로필 `/tmp/massion-growth-gate-uat-20260726`을 사용했으며 자격증명·기억 원문은 이 문서에 기록하지 않았습니다.
- 빌드: `pnpm --filter @massion/desktop tauri:build` 성공

## 실제 관측

| 시나리오 | 결과 |
| --- | --- |
| 앱 기동·준비 상태 | 실제 `Massion.app`과 sidecar가 기동되고 `/health/ready`가 `ready`를 반환 |
| 개인 문맥 | `identity.me`가 owner 개인 조직 문맥을 반환 |
| 조직 | `organization.graph.snapshot`이 Core Office 8개 persistent node만 반환 |
| workspace | trusted workspace 3개가 재조회됨 |
| workspace 파일 첨부 | 실제 workspace의 `README.md`를 `workspacePaths`로 지정한 새 `run.start`가 accepted됨 |
| 실제 Provider Core Work | 같은 Work가 `completed`·terminal이 되었고 representative, context-strategy, evidence-research, assurance, growth가 모두 `succeeded` |
| Knowledge/RAG | `work.knowledge`가 `ready`, 현재 index version과 README reference 2개 반환 |
| Work·index | `work.list`와 `work.index`가 완료 Work와 artifact 계보를 반환 |
| 수신함 | `governance.approval.list`가 기존 approval 상태를 반환하며 만료 항목을 숨기지 않음 |
| Growth·기억 | `growth.configuration.get`, `growth.suggestions`, `growth.effects`, `growth.memories`를 실제 API로 조회. 명시적 memory put/forget도 revision `7→8→9`로 성공했고 재시작 후 version 9와 기존 key가 보존됨. 현재 effect cohort는 0건이며 성공으로 세지 않음 |
| Provider 진단 | `subscription.doctor`가 개인 Z.AI 연결을 `ready`로 반환 |
| 전체 권한 | 실제 bundled 앱에서 `automatic(revision 10) → full-access(revision 11) → automatic(revision 12)` 전환과 `runtimePermissionStatus` 전파를 확인 |
| 재시작 보존 | 앱·sidecar를 종료 후 같은 번들을 재기동하고, 같은 Work의 `completed`·artifact 2개·5개 성공 실행·workspace ID를 재조회 |

## 제한과 미완료

- Computer Use 런타임은 현재 `node_repl`/`@oai/sky`가 제공되지 않아 사용하지 못했습니다. 화면은 macOS 캡처 `/tmp/massion-growth-gate-uat-20260726/e3b5-screen.png`로만 보조 확인했습니다.
- native folder/file picker, 전체 23개 원자 시나리오, 업데이트·제거·재설치, Developer ID 서명·공증, 키보드·VoiceOver 실측은 실행하지 않았습니다.
- Growth 효과 `degraded→revert`는 cohort 최소 조건 미달로 실행하지 않았습니다.
- 따라서 현재 상태는 개인용 v1 구현 및 실제 통합 증분 검증이며 공개 릴리스 게이트 완료가 아닙니다.
