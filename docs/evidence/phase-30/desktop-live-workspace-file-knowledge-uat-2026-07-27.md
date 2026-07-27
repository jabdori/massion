# 실제 Tauri 워크스페이스·파일 첨부·지식 실행 UAT

검증일: 2026-07-27
상태: 실제 Tauri·실제 OpenRouter Provider·실제 SurrealDB에서 통과

## 닫은 사용자 흐름

1. 새 Work에서 신뢰된 workspace directory를 선택했습니다.
2. macOS native folder picker로 workspace를 선택하고 `신뢰`를 눌렀습니다.
3. macOS native file picker로 `history.txt`와 `README.md`를 각각 첨부했습니다.
4. 실제 Provider에 두 파일을 한 문장씩 요약하고 각 문장에 파일 경로를 붙이도록 요청했습니다.
5. EvidenceBrief·Context Strategy·Evidence Research·Delivery·Assurance·Records를 거쳐 완료 Work를 확인했습니다.

## 실제 증거

- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- 번들 내 Evidence resource SHA-256: `prompt-materializer.js=a4eefa77e1bebff41f57f43752a543babf523d17019a5b82fe164a7bef6509b9`, `workspace-knowledge.js=695e11f8648891e9c3f51eb90d18991dea5f3c56814143b67b07eec2b9f988b4`
- Work: `a2dd5289-5d8d-4aa8-9285-364a92e50436`
- Application run: `90a950ca-582e-4d02-836b-6b2050eebb8a`
- 최종 상태: run `terminal/completed`, Work `completed`, Records run `1496281f-5cc4-4355-9f6c-bbf516f5e526`
- IndexVersion: `51d76180-2bf7-4308-82d4-84bdc4a924e2`, `complete`, file 2개, chunk 22개, symbol 7개
- EvidenceBrief: `339ce853-ca39-4c2f-994e-2e064d0defa4`, `ready`, `history.txt`·`README.md` reference 포함
- 최종 task artifact: `6116eb7f-c350-447f-9873-72c1d620fb72`
- Assurance artifact: `b113ca89-784a-47cc-873a-177c61e98189`, verdict `passed`
- 최종 task artifact 원문에는 workspace 루트를 포함한 절대 경로 citation 두 개가 기록됐습니다. 보안상 실제 사용자 경로는 이 문서에 복사하지 않고 `<workspace-root>/history.txt`, `<workspace-root>/README.md`로 표시합니다.

## 실제 실패와 최소 수정

- `.gitignore`에 있는 명시 첨부 파일이 scanner에서 제외되어 `evidence-invalid`가 발생했습니다. 명시된 첨부 경로만 ignore 규칙을 우회하도록 `includeIgnoredPaths`를 추가했습니다.
- 같은 줄의 동일 호출 관계가 같은 relation key를 만들어 SurrealDB unique index 충돌을 냈습니다. relation 순번을 안정적인 key에 포함했습니다.
- 첨부 범위인데 workspace 전체 4,922개 파일과 48만 개 관계를 스캔해 실제 사용 흐름이 과도하게 지연됐습니다. `workspacePaths`가 있으면 선택 파일만 인덱싱하도록 제한했습니다.
- Evidence prompt citation이 상대 경로만 전달되어 Provider 결과가 상대 citation을 출력했습니다. repository root와 상대 경로를 합친 절대 citation을 전달하도록 수정했습니다.
- Work 지식 재시도에서는 immutable `complete`·`superseded` index를 workspace 경로에서만 재사용하고, 일반 `RepositoryStore.startIndex`의 중복 명령 거부 계약은 유지했습니다.

## 집중 검증

- `pnpm --filter @massion/evidence exec vitest run src/indexer.test.ts -t '같은 줄의 동일 호출 관계도 고유 키로 저장한다' --reporter=dot` — 1개 통과
- `pnpm --filter @massion/evidence exec vitest run src/scanner.test.ts src/workspace-knowledge.test.ts src/repository-store.test.ts --reporter=dot` — 14개 통과
- `pnpm --filter @massion/evidence exec vitest run src/workspace-knowledge.test.ts --reporter=dot` — 2개 통과
- `pnpm --filter @massion/evidence typecheck` — 통과
- `pnpm --filter @massion/desktop tauri:build` — 통과

이 기록은 하나의 실제 사용자 수직 흐름만 닫습니다. 전체 10개 시나리오, 재시작·설치·서명·공증·접근성 및 공개 릴리스 게이트는 아직 완료로 표시하지 않습니다.
