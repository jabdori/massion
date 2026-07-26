# 페이즈 02 — 네이티브 폴더·파일 선택

> **상태:** 실제 Tauri folder/file panel 호출·취소 증분 확인 · 파일 선택 완료와 전체 native UAT 대기
> **시작 기준:** 2026-07-25 제품 통합 계획 Task 3
> **다음 게이트:** 지식 그래프·검색·기억의 업무 연결

## 목표

개인용 macOS arm64 v1의 새 Work 대화상자에서 운영체제의 폴더·파일 선택 대화상자를 열어 워크스페이스와 파일 문맥을 고릅니다. 렌더러(renderer)는 선택한 경로를 사용자 경험을 위한 상대 경로로만 바꾸고, 실제 디렉터리·경로·symlink 보안 판정은 이미 구현한 `run.start` 서버 경계가 다시 수행합니다.

## 구현 경계

| 항목 | 포함 | 제외 |
|---|---|---|
| Tauri plugin | 공식 `@tauri-apps/plugin-dialog`과 Rust `tauri-plugin-dialog` | filesystem plugin, custom file browser |
| 권한 | `dialog:allow-open`만 부여 | 범용 파일 읽기·쓰기 capability |
| 반환 계약 | 폴더는 `string | undefined`, 파일은 `readonly string[]` | 선택 경로의 파일 내용 읽기 |
| 취소 | draft를 유지하고 오류로 취급하지 않음 | 취소 후 자동 등록·자동 첨부 |
| UI | 기존 `폴더 추가`·`파일 첨부` 행동에 native dialog 연결 | 별도 파일 관리자 화면 |

## 시작 시 확인한 사실

- 프로젝트는 Tauri 2.11 계열과 Rust `tauri = "2"`를 사용합니다.
- 공식 Tauri dialog 문서는 JavaScript `open({ directory, multiple })`, Rust plugin 등록, `dialog:allow-open` 권한을 요구합니다.
- 현재 데스크톱은 `@tauri-apps/plugin-dialog` 기반 native folder/file picker를 갖고 있습니다. 단, 실제 파일 선택 결과를 같은 workspace의 Work까지 연결한 증거는 아직 없습니다.

## 구현과 커밋

- `a260e1c66` — `@tauri-apps/plugin-dialog` 2.7.2와 Rust `tauri-plugin-dialog` 2.7.2를 등록하고 `dialog:allow-open` capability만 부여했습니다.
- `NativeContextPicker`는 폴더의 단일 선택·취소와 파일의 단일·복수 선택·취소를 각각 `string | undefined`, `readonly string[]`으로 정규화합니다.
- 기존 수동 경로 입력을 제거하고 `폴더 추가`·`파일 첨부`가 실제 native picker를 엽니다. picker 오류는 Work draft 오류와 분리해 표시하고, 정상 취소는 draft를 바꾸지 않습니다.
- 폴더 등록이 진행되는 동안 선택·신뢰·첨부·실행을 잠가 늦은 등록 응답이 기존 파일 문맥이나 실행 대상과 경쟁하지 않게 했습니다.
- renderer의 빠른 검사에는 macOS/POSIX root 경계만 남겼습니다. 선택 root 자체, 밖의 파일, prefix 충돌은 첨부하지 않으며 서버의 canonical 검증을 대체하지 않습니다.

`tauri-plugin-fs`는 dialog plugin의 Rust 전이 의존성일 뿐입니다. 제품 `Cargo.toml`·JavaScript 의존성·capability에 filesystem plugin이나 파일 읽기·쓰기 권한을 직접 추가하지 않았습니다.

## 검증 기록

| 명령 | 결과 | 근거 |
|---|---|---|
| `pnpm --config.store-dir=/private/tmp/massion-pnpm-store-root --filter @massion/desktop test` | 통과 | 9개 파일, 89개 테스트가 picker 정규화·취소·오류·등록 경쟁·기존 Work 흐름을 확인했습니다. |
| 같은 store의 `typecheck`와 `eslint apps/desktop/src` | 통과 | TypeScript 계약과 데스크톱 lint 오류가 없습니다. |
| `cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` | 통과 | Rust plugin과 lockfile이 현재 manifest에서 컴파일됩니다. |
| `cargo metadata --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --format-version 1 --no-deps` | 통과 | lockfile을 새로 쓰지 않고 dependency graph를 해석합니다. |
| `pnpm verify:docs`와 `git diff --check` | 통과 | 문서 구조·링크와 공백 오류를 확인했습니다. |

## 완료 판정

- 폴더 선택은 취소 시 `undefined`, 파일 선택은 취소 시 빈 배열로 정규화됩니다.
- OS 선택 결과를 통해 폴더 등록과 워크스페이스 안 파일 첨부가 기존 draft 보존 규칙을 깨지 않습니다.
- picker 반환 정규화 테스트, desktop test/typecheck, `cargo check`가 통과했습니다.
- 실제 OS dialog 상호작용은 Task 4의 UAT-04·UAT-05에서 Computer Use로 따로 증명합니다.
