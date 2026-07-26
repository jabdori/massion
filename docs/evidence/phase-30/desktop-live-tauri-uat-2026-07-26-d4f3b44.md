# Phase 30 실제 Tauri·Provider 통합 UAT — `d4f3b44f9`

> **상태:** 최신 코드 후보의 실제 Tauri 부트스트랩·화면 연결·API 준비 상태를 통과했습니다. 전체 원자 UAT와 공개 릴리스 완료로는 표시하지 않습니다.

## 후보 경계

- 후보 SHA: `d4f3b44f9`
- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion V1 Candidate.app`
- 실행 경계: 실제 Tauri 실행 파일 → desktop bridge → server → SurrealDB 3.2.1
- 데이터: 기존 실제 Provider 검증이 남긴 격리 local data를 삭제하지 않고 재사용
- secret·token·개인 계정·절대 데이터 경로는 기록하지 않았습니다.

## 실제 관측

| 확인 | 관측 |
| --- | --- |
| 최신 후보 패키징 | `cargo tauri build --bundles app` 성공, 동일 후보 번들 생성 |
| 실제 Tauri 화면 | `massion-desktop` 프로세스와 `Massion` 창이 표시되고 초기 연결 오류 없이 업무 화면을 렌더링 |
| 로컬 준비 상태 | `/health/ready`가 `ready`; application-run-recovery·connectors·database·migrations·runtime-recovery·server-connectors·subscription-quota 모두 준비 |
| API 상태 | `system.status=ready`, `mode=local`, `database=surrealdb-3.2.1`, `modelRuntime=ready`, missing/blocked route 없음 |
| Growth 설정 | `growth.configuration.get`이 `reflectionEnabled=true`, `adoptionMode=auto`, version 2를 반환 |
| 기억 조회 | `growth.memories`가 저장된 사용자 기억 revision 3을 반환 |
| 최신 후보 실제 Provider Work | `tokenBudget=32768`로 시작한 Work가 `completed/terminal`; 대표·context·evidence·assurance·Growth를 포함한 8개 실행 모두 `succeeded` |
| 최신 Work 지식·산출물 | `work.knowledge=ready`, README chunk reference 2개, artifact 4개가 같은 Work에 연결 |
| 입력 예산 경계 | `tokenBudget=2048` 요청은 `intake blocked / evidence-invalid`; 지식 예산이 부족한 입력 경계로 기록하고 성공으로 세지 않음 |
| 재시작 경계 수정 | Growth 복구 상태 hash를 command ID에 포함하고 Work 고정 Prompt·Memory·Policy·Organization 계보를 사용하도록 수정 |
| 중단 Reflection 수정 | 동일 snapshot의 `generating` Reflection을 기존 run ID로 재개하고 부분 Suggestion은 중복 생성을 막기 위해 차단 |
| 동일 번들 재시작·보존 | 앱과 daemon을 종료 후 같은 번들을 재실행; `/health/ready`와 `system.status`가 다시 `ready`, Growth auto version 2·trusted Workspace·memory revision 3 복원 |

## 표적 회귀 검증

```text
pnpm --filter @massion/growth exec vitest run src/reflection.test.ts src/recovery.test.ts --no-file-parallelism --maxWorkers=1
  17 tests passed
pnpm --filter @massion/server exec vitest run src/growth-worker.test.ts --no-file-parallelism --maxWorkers=1
  2 tests passed
pnpm --filter @massion/growth typecheck
pnpm --filter @massion/server typecheck
```

## 완료로 세지 않는 항목

- Computer Use 런타임은 `@oai/cdp-browser-backend` 누락으로 초기화되지 않았습니다. 화면 확인은 OS 캡처와 접근 가능한 macOS 프로세스 확인으로 보완했으며, Computer Use 성공으로 주장하지 않습니다.
- UAT-01~UAT-16, UAT-K01~K04, UAT-G01~G02, UAT-P01~P02 전체 화면·native picker·full-access OS 부작용·Growth 효과/복원 검증은 아직 남아 있습니다.
- 실제 앱 종료 시 진행 중 Provider 호출을 기다리는 경계는 별도 종료 UAT가 필요합니다.
- 공개 Release는 만들지 않았고, 기존 잘못된 공개 `v1.0.0` 제거 상태를 유지합니다.
