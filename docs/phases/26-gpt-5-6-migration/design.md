# Phase 26 — GPT-5.6 모델군 호환성 이관 설계

> **상태**: approved
> **승인일**: 2026-07-12
> **상세 설계**: `docs/superpowers/specs/2026-07-12-gpt-5-6-migration-design.md`
> **선행 상태**: Massion 1.0 runtime과 Model Router 구현 완료; 기존 0~25 제품 프로그램 뒤에 추가된 독립 maintenance 단계

## 1. 목적

Massion의 활성 OpenAI API·Codex 구독 실행 경로를 GPT-5.6 Sol·Terra·Luna 모델군과 호환되게 이관합니다. 역할별 Router, 복수 계정, fallback, 기존 provider와 과거 검증 기준을 보존하며 GPT-5.6에 필요한 endpoint만 좁게 변경합니다.

## 2. 제품 경계

- 직접 OpenAI API에 등록한 공식 GPT-5.6 family만 Responses API로 실행합니다.
- OpenAI-compatible·Ollama·외부 gateway와 기존 OpenAI model은 Chat Completions 경로를 유지합니다.
- 아직 제품에 조립되지 않은 Codex 구독 연결기와 사용자 `config.toml` model 선택은 강제로 덮어쓰지 않습니다.
- 역할별 Sol·Terra·Luna 자동 배치는 Phase 25 평가 결과가 결정하며 Phase 26에서 추측하지 않습니다.
- 대표 평가 전에는 기존 agent prompt를 변경하지 않습니다.

## 3. 요구사항

- `REQ-GPT56-001`: 직접 OpenAI의 `gpt-5.6`, Sol, Terra, Luna는 Responses API를 사용하고 타사·기존 model protocol은 보존합니다.
- `REQ-GPT56-002`: 비활성 Codex 연결기, 사용자 model profile, 기존 provider·fallback·prompt를 변경하지 않은 판정 근거를 보존합니다.
- `REQ-GPT56-003`: 모델·prompt·provider 인벤토리, 변경·미변경 판정, compatibility 검증과 live credential gate를 추적 가능한 회고로 남깁니다.

## 4. 완료 조건

- 상세 설계 12절의 완료 조건을 모두 충족합니다.
- GPT-5.6 Responses와 기존 Chat Completions 경계가 실제 HTTP contract test로 고정됩니다.
- 기존 Codex connector와 타사·기존 model 회귀 테스트가 그대로 통과합니다.
- Runtime 표적 테스트·typecheck·전체 회귀와 문서 검증 결과를 기록합니다.
- 실행하지 못한 live OpenAI API·Codex 계정 검증을 완료로 표현하지 않습니다.
- migration 범위의 미해결 CRITICAL·MAJOR finding이 없습니다.
