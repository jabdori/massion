# Phase 24 — 네이티브 구독 연결기와 실제 사용자 인수 검증 설계

> **상태**: approved
> **승인일**: 2026-07-12
> **상세 설계**: `docs/superpowers/specs/2026-07-12-native-subscription-connectors-design.md`
> **선행 단계**: Phase 0~23 completed

## 1. 목적

Massion이 외부 Gateway 설치를 전제하지 않고 Claude Code, ChatGPT Codex, GLM Coding Plan을 포함한 공식 구독·OAuth·Coding Plan 계정을 네이티브로 연결합니다. 같은 제공자의 여러 계정을 개인 또는 조직 공유 pool로 운영하고 할당량·reset·health를 반영해 회전·fallback합니다.

## 2. 제품 경계

- 구독 계정의 소유권·공유 동의·철회와 사용 계보를 Massion이 소유합니다.
- 공식 SDK·CLI·OAuth·Coding endpoint만 사용하며 다른 프로그램의 token을 역추출하지 않습니다.
- 조직 공용 계정은 서버 연결기, 사용자가 제공한 계정은 사용자 기기 연결기를 기본값으로 사용합니다.
- 모델 제공자와 자체 Tool·sandbox를 가진 Agent runtime을 구분합니다.
- OmniRoute, LiteLLM, Portkey는 선택 가능한 외부 Gateway이며 필수 dependency가 아닙니다.

## 3. 요구사항

- `REQ-SUBSCRIPTION-001`: 복수 구독 계정을 개인·조직 범위와 server·edge 위치로 등록·공유·철회·연결 해제할 수 있습니다.
- `REQ-SUBSCRIPTION-002`: `adaptive` 정책이 복수 quota window, reset 시각, health, sticky와 실시간 실패를 결정론적으로 반영합니다.
- `REQ-SUBSCRIPTION-003`: Hermes Agent의 기본 제공자 범위를 참고한 공식 구독·OAuth·Coding Plan 연결기를 Massion이 직접 제공합니다.
- `REQ-SUBSCRIPTION-004`: 실제 Claude, Codex, GLM 계정과 최종 release artifact를 `tmux` 사용자 시나리오로 검증하고 비밀이 제거된 영수증을 남깁니다.

## 4. 완료 조건

- 상세 설계 14절의 완료 조건을 모두 충족합니다.
- 기존 API key·Gateway·local model·Core Office·Software Engineering 경로에 회귀가 없습니다.
- 전체 품질·보안·강건성·설치 릴리스 검증을 다시 통과합니다.
- 미해결 CRITICAL·MAJOR finding이 0이며 실행하지 못한 실제 외부 계정은 명시합니다.
