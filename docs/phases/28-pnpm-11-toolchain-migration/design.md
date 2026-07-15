# Phase 28 — pnpm 11 보안 감사 도구 체인 이관 설계

> **상태**: approved
> **결정일**: 2026-07-15
> **선행 상태**: Phase 24의 현재 source 검증과 실제 계정 UAT는 진행 중이며, Phase 27의 깨끗한 Core 저장소 전환은 완료되었습니다.
> **문제 기준**: 고정된 pnpm 10의 production audit은 npm이 폐기한 감사 endpoint를 호출해 취약점 결과가 아닌 오류 envelope를 반환했습니다.

## 1. 결정

Massion의 개발·CI·release·Docker build 도구 체인을 `pnpm@11.13.0`으로 통일합니다. pnpm 11이 공식적으로 사용하는 Registry Bulk Advisory 경로를 `pnpm audit --prod --json`으로 호출하고, 기존 `verify:security`의 moderate·high·critical 차단 정책을 유지합니다.

직접 HTTP Bulk Advisory client를 제품 검증 스크립트에 추가하지 않습니다. package manager가 생산 의존성 그래프, workspace link, optional dependency, registry 설정과 meta-vulnerability를 판단하는 책임을 그대로 가집니다. Registry 오류는 성공으로 바꾸는 `--ignore-registry-errors`를 사용하지 않습니다.

## 2. 변경 경계

### 2.1 도구 체인 계약

- root `packageManager`, CI, release workflow, 두 Docker build 경로와 개발 안내는 같은 `pnpm@11.13.0`을 가리킵니다.
- pnpm 11이 읽지 않는 root `package.json`의 `pnpm.overrides`는 `pnpm-workspace.yaml` 최상위 `overrides`로 옮깁니다.
- 기존 `onlyBuiltDependencies: []`는 pnpm 11의 `allowBuilds` 정책으로 이관합니다.
- `protobufjs@7.6.5`의 `postinstall`은 명시적으로 `false`로 거부합니다. 그 밖의 승인되지 않은 dependency build script도 기본값으로 허용하지 않습니다.

### 2.2 보안 검증 계약

- `pnpm audit --prod --json`이 정상 audit report를 반환할 때만 기존 severity gate가 결과를 판정합니다.
- audit error envelope, 빈 출력, JSON 구조 오류는 취약점 0으로 해석하지 않고 실패합니다.
- low advisory는 관측값으로 남기되, moderate·high·critical은 배포 차단 조건입니다.

## 3. 요구사항

- `REQ-TOOLCHAIN-001`: 모든 개발·CI·release·Docker 진입점은 정확히 같은 pnpm 11.13.0과 workspace 설정을 사용합니다.
- `REQ-TOOLCHAIN-002`: production audit은 fail-closed를 유지하고, 깨끗한 고정 설치·품질·보안·release 검증 결과를 source commit과 로그 digest에 결속합니다.

## 4. 범위 밖 항목

- 제품 의존성 버전, lockfile의 해결 그래프, Provider 동작, 실제 계정 UAT, Cloud 경계와 라이선스 정책은 이 Phase에서 바꾸지 않습니다.
- Phase 24의 실제 Codex profile 재사용 UAT와 다중 계정 fallback UAT는 이 도구 체인 이관으로 완료되지 않습니다.
- Phase 26과 Phase 27의 과거 실행 환경·검증 결과는 역사 증거이므로 다시 쓰지 않습니다.

## 5. 완료 조건

1. 고정 설치가 pnpm 11에서 lockfile 변경 없이 통과합니다.
2. 도구 체인 계약 테스트가 manifest·workspace·CI·Docker·개발 안내의 불일치를 거부합니다.
3. `pnpm verify`, `pnpm verify:security`, `pnpm verify:hardening`, release build와 release 검증이 새 source commit에서 통과합니다.
4. 검증 결과, source digest, 로그 digest, 낮음 advisory 관측값과 범위 밖 UAT를 Phase 28 evidence에 기록합니다.

## 6. 외부 기준

pnpm 11은 `pnpm audit`에 Registry Bulk Advisory endpoint를 사용하고 production-only audit과 JSON 출력을 지원합니다. pnpm 설정 문서는 `onlyBuiltDependencies` 계열이 pnpm 11에서 제거되고 `allowBuilds`로 대체된다고 명시합니다. [pnpm audit 문서](https://pnpm.io/cli/audit), [pnpm settings 문서](https://pnpm.io/settings#allowbuilds)를 기준으로 합니다.
