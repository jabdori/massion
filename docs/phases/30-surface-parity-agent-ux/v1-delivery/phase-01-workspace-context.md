# 페이즈 01 — 홈의 워크스페이스·파일 문맥

> **상태:** 코드 검증 완료 · native UAT 대기
> **시작 기준:** 2026-07-25 제품 통합 계획 Task 2
> **다음 게이트:** 네이티브 폴더·파일 선택(Task 3)

## 목표

사용자가 내부 식별자(identifier)를 입력하지 않고 저장한 폴더를 이름으로 선택해 Work를 시작할 수 있게 합니다. 선택한 파일은 워크스페이스 기준 상대 경로로만 전달하며, 서버가 실제 경로와 심볼릭 링크(symbolic link) 탈출을 다시 확인합니다.

## 이 페이즈에서 바꾸는 경계

| 경계 | 책임 |
|---|---|
| Workspace | 실제 디렉터리만 canonical path로 등록하고 일반 파일·외부 symlink를 거부합니다. |
| Application run | `workspacePaths`를 구조적으로 검증하고 중복을 제거한 뒤 선택 workspace 안의 실제 파일인지 확인합니다. |
| Core Work | 검증된 파일 상대 경로를 요청·대표 에이전트 입력까지 보존합니다. |
| Desktop | raw workspace ID 입력을 없애고 폴더 이름·경로 선택과 파일 문맥 입력을 제공합니다. |

## 확인된 시작 상태

- `WorkspaceService.register()`에 실제 디렉터리 검증을 추가한 변경이 작업 트리에 있었고, focused test는 `9 passed`였습니다.
- Application run의 새 파일 문맥 테스트는 구현 전 `workspace file 경로` 예외가 발생하지 않아 실패했습니다.
- 기존 application domain test는 존재하지 않는 절대 경로를 사용해 실제 디렉터리 경계와 충돌했습니다.

이 세 사실은 페이즈 시작 시점의 재현 결과입니다. 이후 상태는 아래 검증 기록으로만 갱신합니다.

## 구현과 커밋

- `fedfb3922` — 실제 디렉터리 등록, `workspacePaths` 공개 계약, POSIX 상대 경로 정규화·중복 제거·최대 20개 제한, active canonical root와 파일 containment 검증을 Work 시작에 연결했습니다.
- `57632eed1` — 내부 workspace ID 입력을 폴더 이름·경로 선택으로 교체하고, pending 신뢰·상대 파일 첨부·draft 보존·stale 목록 및 지연된 신뢰 응답 조정을 데스크톱에 연결했습니다.

## 검토에서 확인해 보완한 경계

- Workspace 명령과 목록은 같은 완전한 공개 뷰를 제공하며, 데스크톱은 malformed workspace 응답을 상태에 넣지 않습니다.
- `workspaceId`만 있는 Work도 active 실제 디렉터리인지 다시 확인합니다. archive, symlink 교체, 디렉터리가 일반 파일로 바뀐 경우는 Work 시작 전에 거부합니다.
- 폴더를 바꾸거나 최신 목록에서 선택 폴더가 blocked·archived가 되면 첨부 목록과 아직 첨부하지 않은 파일 입력을 함께 비웁니다.
- 늦게 돌아온 신뢰 응답은 사용자가 그 사이 선택한 다른 폴더를 덮어쓰지 않습니다.
- Work 목록·상세 화면은 workspace가 있는 사실만 일반 문구로 표시하며 내부 workspace ID를 화면에 노출하지 않습니다.

## 구현 규칙

- 파일 경로 검증에 자유 문구인 `scopeIn` 검증을 재사용하지 않습니다.
- 화면의 경로 검사만 신뢰하지 않습니다. `run.start` 처리 직전에 canonical workspace root와 선택 파일의 realpath를 비교합니다.
- 워크스페이스가 없는 일반 Work는 계속 시작할 수 있습니다.
- native dialog는 다음 페이즈에서 공식 Tauri dialog plugin으로만 붙입니다. 이 페이즈에는 새 파일 브라우저나 filesystem 권한을 추가하지 않습니다.

## 검증 기록

| 명령 또는 행동 | 결과 | 근거 |
|---|---|---|
| `pnpm --filter @massion/workspace test` | 통과 | 1개 파일, 9개 테스트가 실제 디렉터리·일반 파일·외부 symlink 등록 경계를 확인했습니다. |
| `pnpm --filter @massion/application test -- run-commands.test.ts adapters/domain.test.ts` | 통과 | 패키지 스크립트의 전체 source 실행으로 52개 파일 통과, 2개 의도된 skip, 325개 테스트 통과입니다. |
| `pnpm exec eslint apps/desktop/src` | 통과 | 새 대화상자와 controller를 포함한 데스크톱 추적 소스의 lint 오류가 없습니다. |
| `pnpm --filter @massion/desktop test -- app.integration.test.tsx desktop-service.test.ts` | 통과 | 7개 파일, 77개 테스트가 이름 선택·경로 전달·draft 보존·stale 선택 및 지연 응답을 확인했습니다. |
| `pnpm --filter @massion/desktop typecheck` | 통과 | Desktop service·controller·dialog 계약이 TypeScript 빌드를 통과했습니다. |
| `pnpm verify:docs`와 `git diff --check` | 통과 | 문서 구조·링크와 이번 변경의 공백 오류를 확인했습니다. |

## 다음 구현자가 확인할 것

1. 실제 폴더·파일 선택 UX는 Task 3의 native picker UAT로만 완료 판정합니다. 현재 텍스트 경로 입력은 그 전까지의 typed fallback입니다.
2. 이 페이즈가 통과해도 코드 관계 색인·검색·기억 주입은 아직 다음 지식·기억 페이즈의 범위입니다.
3. Core UAT는 지식·기억 선행 게이트와 native picker가 모두 닫힌 뒤 시작합니다.
