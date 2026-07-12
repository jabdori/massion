# Phase 26 — GPT-5.6 모델군 호환성 이관 구현 계획

> **상태**: completed
> **상세 계획**: `docs/superpowers/plans/2026-07-12-gpt-5-6-migration.md`
> **방법**: 공식 근거 확인→실패 테스트 확인→최소 구현→관련 회귀 검증→회고 순서를 지킵니다.

## Task 1. 사용 지점·공식 계약 인벤토리

- [x] 저장소의 활성 model ID, provider, endpoint, reasoning, tool, prompt 사용 지점을 조사했습니다.
- [x] GPT-5.6 최신 모델·이관·prompt·Codex 모델 공식 문서를 직접 확인했습니다.
- [x] 활성 기본 model ID가 없고 운영 DB의 사용자 등록 `model_profile.model_id`가 정본임을 확인했습니다.

## Task 2. GPT-5.6 Responses 호환성

- [x] 공식 OpenAI GPT-5.6 Sol의 `/responses` 실패 계약을 확인했습니다.
- [x] 공식 endpoint·AI SDK adapter·정확한 model ID를 함께 확인하는 최소 분기를 구현했습니다.
- [x] family alias·Terra·Luna도 Responses provider를 사용하는지 검증했습니다.
- [x] Responses HTTP body에 개인정보 우선 기본값 `store:false`가 포함되는 실패 계약을 추가하고 통과했습니다.

## Task 3. 기존 protocol·사용자 소유권 보존

- [x] 기존 OpenAI model은 Chat Completions를 유지함을 검증했습니다.
- [x] 사용자 지정 `ai-sdk`, OpenAI-compatible, Ollama endpoint는 Chat Completions를 유지함을 검증했습니다.
- [x] 비활성 Codex connector, model registry, fallback, 가격표, 과거 문서·fixture와 prompt를 변경 대상에서 제외했습니다.

## Task 4. 검증·추적·회고

- [x] Runtime 표적 test·전체 test·typecheck를 통과했습니다.
- [x] 문서·전체 저장소·보안 gate를 실행하고 통과·실패 결과를 구분해 기록했습니다.
- [x] 요구사항 추적표와 Phase 26 회고에 변경·미변경·외부 gate를 연결했습니다.
