# Phase 27 — 깨끗한 복제본 검증 증거

> 검증일: 2026-07-13
> 원격: `https://github.com/jabdori/massion.git`
> 검증 대상 커밋: `6777f3b0a5922e9349862214843ebf98905a53cc`

## 범위

`main`을 `git clone --no-local`로 빈 임시 디렉터리에 복제한 뒤, 잠금 파일을 고정한 의존성 설치와 전체 품질 검증을 실행했습니다. 이 문서에는 비밀값이나 원시 터미널 출력을 넣지 않고 종료 코드와 요약만 기록합니다.

| 단계 | 결과 |
|---|---|
| `git clone --no-local --branch main` | 종료 코드 0 |
| `pnpm install --frozen-lockfile` | 종료 코드 0 |
| 추적 파일 검사 | 904개, legacy 경로 0건 |
| `pnpm verify` | 종료 코드 0: format, build, lint, typecheck, 전체 test, 문서 검증 통과 |
| `pnpm release:build` | 종료 코드 0; commit-bound local/deploy archive 생성 |
| `pnpm verify:release` | 종료 코드 0; 설치, 실행, backup restore, uninstall 후 data 보존 통과 |

## 복제본 release 묶음

- local archive: `massion-local-1.0.0.tar.gz`
- local archive SHA-256: `sha256:3771998673eb9720336dc8db4321a078c431be9c2f60b96cfddad74b3be51f67`
- deploy archive SHA-256: `sha256:b6bfff574d015bfb0eddf0e14b6d60a51409164a9d7b0413ad3c0969129134b6`
- toolchains: Node `24.8.0`, Bun `1.3.14`, pnpm `10.30.3`

`verify:release`의 구조화된 결과는 `status: passed`, `connector: ready`, `backup: restored`, `uninstall: data-preserved`였습니다. release 임시 설치 과정에서 peer dependency 안내가 출력되었지만 명령 종료 코드는 0이며 품질·release 게이트를 통과했습니다.

## 범위 밖 항목

Codex·Claude·Z.AI의 실제 소비자 인증은 별도의 Phase 24 UAT에서 다룹니다. 대화형 로그인 또는 제공자 승인이 필요한 시나리오는 자격 증명 없이 성공으로 표시하지 않습니다.
