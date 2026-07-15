# Phase 28 — pnpm 11 보안 감사 도구 체인 이관 구현 계획

> **상태**: in-progress
> **설계**: `docs/phases/28-pnpm-11-toolchain-migration/design.md`
> **방법**: 실패 원인 재현 → 도구 체인·정책 이관 → 고정 설치 → 품질·보안·release 검증 → evidence·회고

## Task 1. 폐기된 audit 경로와 목표 도구 체인 고정

- [x] pnpm 10의 production audit이 폐기된 endpoint 오류 envelope를 반환하는지 관측합니다.
- [x] pnpm 11.13.0이 현재 Node 24 환경에서 audit report의 `metadata.vulnerabilities` 구조를 반환하는지 확인합니다.
- [x] 직접 Registry client가 아니라 pnpm 11의 공식 audit 경로를 선택하고, Registry 오류를 성공으로 처리하지 않는 정책을 고정합니다.

## Task 2. 실행 경로와 workspace 보안 정책 이관

- [x] `packageManager`, CI, release workflow, Dockerfile 두 개와 README의 pnpm 버전을 11.13.0으로 통일합니다.
- [x] root `pnpm.overrides`를 `pnpm-workspace.yaml` 최상위 `overrides`로 옮깁니다.
- [x] 기존 build script 전면 비허용 정책을 `allowBuilds`로 이관하고 `protobufjs: false`를 명시합니다.
- [x] manifest·workspace·CI·Docker·개발 안내의 버전과 정책을 함께 검사하는 계약 테스트를 추가합니다.
- [x] audit 오류 envelope가 severity 0으로 통과하지 않는 회귀 테스트를 추가합니다.

## Task 3. 검증 기준점과 회고 고정

- [x] pnpm 11의 `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm verify:security`를 실제 작업공간에서 실행합니다.
- [ ] 변경을 하나의 source commit으로 고정하고 source digest를 기록합니다.
- [ ] 새 source commit에서 hardening, release build, release verify와 Docker build 경로를 재검증합니다.
- [ ] clean clone 결과·audit 요약·로그 digest를 Phase 28 evidence에 기록하고 요구사항 추적표를 completed로 갱신합니다.

이 Phase는 Phase 24 외부 계정 UAT를 대체하지 않습니다. 실제 Provider 인증·quota·fallback 검증은 해당 Phase의 미완료 작업으로 남깁니다.
