# 실제 Tauri workspace 디렉터리 문맥·첨부 경계 UAT — `40a6ffbc8`

> 동일 후보 내용의 실제 Massion.app에서 workspace 디렉터리 문맥과 잘못된 디렉터리 첨부 입력을 확인한 증거입니다. 전체 23개 원자 UAT나 공개 릴리스를 완료했다는 뜻은 아닙니다.

## 실행 경계

- 후보 커밋: `40a6ffbc8c0df10db9a3e3fae14ea67322a75b6a`
- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- 실행: Tauri 앱 → bundled bridge/server → SurrealDB 3.2.1
- 데이터: 기존 격리 프로필 `/tmp/massion-growth-gate-uat-20260726` 재사용

## 실제 결과

| 시나리오 | 결과 |
| --- | --- |
| workspace 디렉터리 등록 문맥 | `workspace.get`이 `local-directory`, `trusted`, `active` workspace를 반환 |
| 디렉터리만 문맥으로 지정 | `run.start`에 `workspaceId`만 지정한 Work가 accepted 후 `terminal/completed` |
| 실제 Provider 실행 | representative, context-strategy, evidence-research 5개, assurance, growth 실행이 모두 `succeeded` |
| Work 계보 | 완료 Work가 artifact 6개와 `indexVersionId`를 보존. 해당 자연어 질의는 `work.knowledge.status=no-match`였으며 오류가 아닌 신선한 빈 검색 결과로 반환 |
| 잘못된 디렉터리 첨부 | `workspacePaths:["src"]` 입력이 `APP_WORKSPACE_PATH_VALIDATION` 검증 오류로 반환. `APP_INTERNAL`로 숨겨지지 않음 |

## 동일 후보 재기동 확인

같은 `40a6ffbc8` 코드 번들을 다시 시작한 뒤 다음 14개 Application 조회가 모두 오류 없이 응답했습니다: `identity.me`, `organization.graph.snapshot`, `workspace.list`, `workspace.get`, `work.list`, `work.index`, `work.knowledge`, `work.executions`, `governance.approval.list`, `growth.configuration.get`, `growth.suggestions`, `growth.effects`, `growth.memories`, `subscription.doctor`.

- 기존 README 첨부 Work의 `work.knowledge`는 `ready`, reference 2개, 같은 index version을 반환했습니다.
- 실제 `governance.autonomy.set`은 `automatic(revision 12) → full-access(revision 13, runtimePermissionStatus=full-access) → automatic(revision 14, governed)`로 전파됐습니다.
- 앱·server·SurrealDB는 검증 뒤 종료했습니다.

## 코드·자동화 확인

- `pnpm --filter @massion/application exec vitest run src/run-commands.test.ts --no-file-parallelism --maxWorkers=1 --reporter=dot` — 4/4 통과
- `pnpm --filter @massion/application typecheck` — 통과
- `pnpm --filter @massion/desktop tauri:build` — `Massion.app` 생성 성공
- 디렉터리 첨부 경계 회귀 테스트가 `APP_WORKSPACE_PATH_VALIDATION`과 요청 `correlationId`를 고정

## 범위 제한

- 첨부 경로(`workspacePaths`)는 기존 파일만 허용하는 계약을 유지했습니다. 디렉터리 자체는 `workspaceId`로 문맥에 추가합니다.
- native picker, 전체 23개 원자 시나리오, 업데이트·제거·재설치, 서명·공증, 키보드·VoiceOver 및 Computer Use는 이 증거에서 검증하지 않았습니다.
