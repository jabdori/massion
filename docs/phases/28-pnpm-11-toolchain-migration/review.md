# Phase 28 — pnpm 11 보안 감사 도구 체인 이관 회고

> **상태**: completed
> **검증일**: 2026-07-15
> **구현 source commit**: `32bc0993a1ad88c790e4855be733852de8a12f25`
> **상세 증거**: `docs/evidence/phase-28/pnpm-11-toolchain-verification-2026-07-15.md`

## 결과

pnpm 10에서 오류 envelope를 취약점 0건으로 오인할 수 있던 감사 경로를 제거하고, Massion의 개발·CI·release·Docker 진입점을 pnpm 11.13.0으로 통일했습니다. `allowBuilds`에 승인되지 않은 dependency build script를 차단하는 정책과 감사 오류 fail-closed 계약을 함께 고정했습니다.

고정된 source commit에서 frozen install, 전체 품질 검증, 보안 검증, hardening, release build·verify를 모두 종료 코드 0으로 통과했습니다. 같은 commit을 빈 디렉터리에 `git clone --no-local`한 clean clone에서도 install, 전체 검증, security, release build·verify가 동일하게 통과했습니다.

Docker는 Caddy 최종 image와 root production stage의 OCI export를 통과했습니다. Docker daemon의 root 최종 image unpack은 저장 공간 부족으로 실패했지만, Dockerfile의 production stage 자체는 OCI archive export로 완주했습니다. 이 환경 제약은 코드 성공으로 기록하지 않았습니다.

## 남은 범위

실제 Codex·Claude·Z.AI 계정 인증, quota, 복수 계정 rotation·fallback UAT는 Phase 24의 사용자 계정 기반 종료 조건으로 남아 있습니다. 이 Phase의 도구 체인 검증을 외부 provider 실행 성공으로 해석하지 않습니다.
