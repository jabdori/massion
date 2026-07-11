# Phase 24 — 네이티브 구독 연결기와 실제 사용자 인수 검증 구현 계획

> **상태**: planned
> **상세 계획**: `docs/superpowers/plans/2026-07-12-native-subscription-connectors.md`
> **방법**: 각 항목에서 실패 테스트 확인→최소 구현→관련 회귀 검증→커밋 순서를 지킵니다.

## Task 1. 구독 계정 정본

- [x] `@massion/subscriptions` package와 append-only migration을 추가합니다.
- [x] 개인·조직 scope, 공유 동의·철회, connector와 quota snapshot 원장을 TDD로 구현합니다.
- [x] secret·이메일·외부 account ID가 공개 query·event·metric에 나오지 않게 검증합니다.

## Task 2. 할당량 기반 라우팅

- [x] ProviderCredential을 암호화 비밀 또는 연결기 세션 union으로 확장합니다.
- [x] 복수 quota window와 `adaptive` 선택을 RED→GREEN으로 구현합니다.
- [ ] 출력 전·후 실패, cooldown, reset, stale snapshot과 cross-provider fallback을 검증합니다.

## Task 3. 서버·사용자 기기 연결기

- [x] 연결기 protocol, 등록, 장치 서명, heartbeat, lease와 replay 방지를 구현합니다.
- [x] 서버 연결기의 계정별 profile·process 격리와 사용자 기기 offline·reconnect를 검증합니다.
- [x] Governance approval과 runtime suspend·resume을 연결합니다.

## Task 4. 공식 제공자 연결기

- [x] Codex SDK·app-server와 Claude Agent SDK 연결기를 구현합니다.
- [ ] Gemini CLI, Copilot ACP, Qwen, MiniMax, xAI, Nous 구독·OAuth 연결기를 구현합니다.
- [ ] GLM, Kimi, StepFun, Alibaba, OpenCode Go, Kilo Coding Plan preset과 capability probe를 구현합니다.

## Task 5. Application과 사용자 화면

- [ ] 구독 provider·account·quota·policy·doctor query와 connect·share·unshare·disconnect command를 추가합니다.
- [ ] CLI의 `mass subscription ...` UX를 구현합니다.
- [ ] TUI·Web에서 같은 Application operation과 redacted view를 제공합니다.

## Task 6. 제품 조립과 실제 사용자 검증

- [ ] 설치형 서버·로컬 lifecycle·team deploy에 connector broker를 조립합니다.
- [ ] 깨끗한 release 설치를 `tmux`에서 실행하고 Claude·Codex·GLM 실제 계정 시나리오를 검증합니다.
- [ ] 복수 계정 회전·quota·offline·429·fallback·중단·재개·재시작·백업·복원을 검증합니다.
- [ ] 전체 검증, 요구사항 추적표, 아키텍처, 운영 문서와 Phase 24 회고를 실제 결과로 완료합니다.
