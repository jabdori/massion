# 실제 Tauri·Provider Work·재시작 보존 증거 — `573297642`

> 이 기록은 제품 후보에서 실제 Provider로 하나의 Work를 실행하고 같은 격리 프로필을 재기동해 조회한 증분 증거입니다. 23개 원자 UAT, 서명·공증 또는 공개 릴리스를 완료했다는 뜻은 아닙니다.

<!-- desktop-uat-evidence: actual-tauri -->
<!-- desktop-release-candidate-sha: 573297642a41088a662aa58690ca16f2a43e84b6 -->

## 실행 경계

- 후보 SHA: `573297642a41088a662aa58690ca16f2a43e84b6`
- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- 실행 경계: Tauri 앱 → bundled Node bridge/server → SurrealDB 3.2.1
- Provider: 사용자가 등록한 Z.AI 연결이 실제 런타임에서 `ready`로 확인됨
- 데이터: 자격증명과 원문 기억을 문서에 남기지 않는 격리 프로필 사용

## Work 실행 결과

실제 Application 명령(application command)에 제품 스키마를 포함해 `README.md`를 workspace 문맥으로 지정하고, 파일을 변경하지 않는 요약 요청을 보냈습니다.

| 관측 | 결과 |
| --- | --- |
| `run.start` 접수 | accepted 후 실제 Provider 실행으로 전환 |
| Work 상태 | `completed`, revision `16` |
| 산출물 | artifact `2`개 |
| 지식 계층 | `work.knowledge=ready`, reference `2`개, index version 보존 |
| 실행 계보 | representative, context-strategy, evidence-research, assurance, growth 실행 `5`개 모두 `succeeded` |
| Provider 진단 | Z.AI connector `ready` |

## 재시작 후 보존

앱·bundled server·SurrealDB를 종료한 뒤 같은 후보 번들과 같은 격리 프로필을 다시 기동했습니다. 준비 상태가 다시 `ready`가 된 후 다음 값을 재조회했습니다.

- 동일 workspace ID와 동일 Work가 다시 조회됨
- Work는 계속 `completed`, revision `16`, artifact `2`개
- `work.knowledge`는 계속 `ready`, reference `2`개
- 이전 실행 계보 `5`개는 모두 성공 상태로 보존됨
- 개인 기억은 `1`개, revision `9`로 보존됨
- 자동 권한은 revision `14`, 런타임 상태 `governed`로 보존됨
- Growth 제안 `24`개가 재조회됨(`proposed 18`, `adopted 1`, `awaiting-review 5`)

## 제한

- Growth effect는 `0`건이므로 효과 cohort 성공으로 세지 않았습니다.
- native 파일 선택 완료, 전체 23개 원자 시나리오, 깨끗한 설치·업데이트·제거·재설치, 비정상 종료, 접근성, Developer ID 서명·공증은 별도 gate로 남아 있습니다.
- 이 문서는 실제 제품 경로의 한 세로 흐름과 재시작 보존만 증명하며, 릴리스 완료 표식으로 사용하지 않습니다.
