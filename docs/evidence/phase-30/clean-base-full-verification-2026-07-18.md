# Phase 30 — 깨끗한 기준선 전체 검증 증거

> **검증 범위:** 기준선 재현성(reproducibility)만 검증
> **기준 소스 커밋(source commit):** `65922bd706580a0962b6eda81c6fa3d63b36b6a8`
> **기준 트리(base tree):** `f68d7452964ac98b0235bc6b8f8c11840b6da128`

## 실행 기록

### 최초 검증

> **검증 시작:** 2026-07-18T04:04:52Z
> **검증 종료:** 2026-07-18T04:31:35Z (26분 43초)

기준 소스 커밋을 가리키는 격리된 분리 워크트리(detached worktree)에서 검증했습니다. 검증이 끝난 뒤 워크트리 상태는 깨끗했습니다(clean).

| 항목 | 확인값 |
| --- | --- |
| 운영체제·아키텍처 | Darwin arm64 |
| Node.js | v24.8.0 |
| pnpm | 11.13.0 |
| Bun | 이 실행에서는 버전을 기록하지 않음 |

| 명령 | 종료 코드 | 확인 범위 |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | 0 | 고정된 lockfile로 의존성 설치 |
| `pnpm verify` | 0 | 기준 `package.json`에 정의된 format 검사, 전체 workspace build, ESLint, 형 검사(typecheck), root·workspace test, 문서 검증 |

### 재실행

> **검증 시작:** 2026-07-18T10:23:41Z
> **검증 종료:** 2026-07-18T10:42:38Z (18분 57초)

같은 기준 소스 커밋을 가리키는 별도 worktree에서 동결 설치와 전체 품질 게이트를 다시 실행했습니다. `pnpm verify`가 끝난 직후 Git 작업 트리와 staged diff는 모두 깨끗했습니다(clean).

| 항목 | 확인값 |
| --- | --- |
| 운영체제·아키텍처 | Darwin arm64 |
| Node.js | v24.8.0 |
| pnpm | 11.13.0 |
| Bun | 1.3.14 |
| 검증 뒤 Git 작업 트리·staged diff | clean |

| 명령 | 종료 코드 | 확인 범위 |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | 0 | 고정된 lockfile로 의존성 설치 |
| `pnpm verify` | 0 | 기준 `package.json`에 정의된 format 검사, 전체 workspace build, ESLint, 형 검사(typecheck), root·workspace test, 문서 검증 |

기준 `package.json`의 `verify` 명령은 `pnpm format:check`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm verify:docs`를 순서대로 실행하도록 정의되어 있습니다. 재실행의 `pnpm test`에는 Bun 1.3.14로 실행한 OpenTUI renderer·키 입력 자동 테스트가 포함됩니다. 따라서 위 결과는 이 기준선에서 정의된 전체 품질 게이트(quality gate)가 재현되었음을 뜻합니다.

## 증명하지 않는 범위

이 증거는 기준선의 재현성만 증명합니다. 다음은 아직 증명하지 않습니다.

- 복구 조각(slice)의 복원 또는 현재 정합성 복구 브랜치의 검증 게이트
- 릴리스(release) 준비 상태
- Playwright와 실제 단말 OpenTUI·tmux 사용자 흐름 검증
- 백업·복원(backup/restore) 검증
- 공급자(provider) 실제 사용자 인수 테스트(UAT)
