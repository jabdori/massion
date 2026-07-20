# Phase 30 GLM 도그푸딩 UAT (2차) — 2026-07-21

> **결과:** 통과
> **범위:** Z.AI GLM-5.2 Coding Plan으로 코드 작성 요청 전체 파이프라인 실행
> **기준 commit:** `09bafc1`

## 확인한 흐름

1. 서버가 이미 실행 중인 상태에서 `massion run "1부터 10까지 더하는 Python 함수를 작성하고 테스트해줘" --json --wait`을 실행했습니다.
2. 업무가 생성되고 draft 상태에서 시작해 파이프라인 전 단계를 통과했습니다.
3. 최종 상태: `verifying`, revision 16, 산출물 2개 생성.
4. Core Office 협업방에 9명 참가자(8개 에이전트 조직 + 사용자)가 활성화되어 있고, 에이전트 간 handoff가 정상 동작했습니다.
5. `massion status --json` 결과: `status: ready`, `modelRuntime: ready`, 누락 route 없음.

## 이전 대비 개선

2026-07-20 UAT에서 "복잡한 요청(코드 작성 포함)에서 delivery 단계가 시간 초과로 blocked 될 수 있습니다"로 기록했던 제한이 해결되었습니다. 코드 작성 요청이 delivery를 통과해 assurance(verifying) 단계까지 도달하며 산출물 2개를 생성했습니다.

## 환경

- source commit: `09bafc1`
- runtime: native SurrealDB 3.2.1 darwin-arm64 sidecar (PID 30724)
- application server: PID 30725, http://127.0.0.1:7331
- model: glm-5.2 (Z.AI Coding Plan, API key 기반)
- 업무 ID: `998a7951-05b6-42ea-adec-0b9cf4fb39b9`

## 업무 목록 (검증 시점)

| 업무 ID | 상태 | 수정 | 산출물 |
|---------|------|------|--------|
| 998a7951 | verifying | 16 | 2 |
| 3cef0326 | verifying | 16 | 2 |
| 4e6e5bab | draft | 3 | 0 |

## 제한

- 단일 GLM 계정만 검증됨. 복수 계정 순환 및 fallback은 구조와 단위 테스트는 구현됐지만 실제 다계정 UAT는 사용자 계정이 필요함.
- Claude 소비자 구독 실계정 UAT는 브라우저 OAuth 로그인이 필요함.
