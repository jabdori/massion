# Phase 31 — 작업 인지 모델 배치 설계

> **상태**: in-progress
> **결정일**: 2026-07-28
> **선행 조건**: Phase 30 `docs/phases/30-surface-parity-agent-ux/design.md`가 아직 `in-progress`입니다. Phase 30의 기능 동등화·Agent runtime 표면 검증을 선행 조건으로 유지하고, 모델 배치 표면은 그 계약 위에 연결합니다.
> **결정 근거**: [ADR-003 — 작업 인지 모델 배치](../../architecture/ADR-003-task-aware-model-placement.md)

## 1. 목적

헌법 §4.12가 선언했으나 구현된 적 없는 작업 인지 모델 선택을 구현합니다. 역할별 평가실이 제공하는 후보 집합 안에서 전략이 판정한 과제의 난이도와 작업 성격을 실행 시점에 사용해 모델을 고르고, 근거·실행·Assurance 계보를 하나로 기록합니다.

## 2. 제품 경계

- 역할 키를 난이도와 결합하지 않습니다. 역할별 활성 batch는 후보 집합을 제공하고 작업 축은 실행 시점 선택에만 사용합니다.
- 사용자가 요청마다 모델을 고르는 채팅 앱을 만들지 않습니다. 사용자는 자신이 가진 모델 중 가장 강한 기준 모델을 자원으로 한 번 신고합니다.
- Governance `riskClass`와 계획 위험을 추론 요구량으로 해석하지 않습니다.
- 다섯 작업 성격은 코드 생성, 코드 이해·설명, 계획·설계, 검토·비판, 요약·기록입니다. 긴 문맥·도구·구조화 출력·비전은 점수 축이 아니라 하드 gate입니다.
- T0 동봉 벤치, T1 클라이언트 로컬 벤치, T2 실제 Work 관찰의 권한을 분리합니다. T2는 초기 순위 상승에 쓰지 않습니다.
- 기존 모델 평가실·라우터·Growth Assurance 효과 기계를 재사용하고 새 채점기를 만들지 않습니다.
- Phase 30이 제공하는 공통 표면 계약 밖에서 별도 모델 선택 UI를 만들지 않습니다.

## 3. 요구사항

- `REQ-PLACEMENT-001`: 실행 정본이 모델 시도와 이어져야 합니다. `route_attempt.execution_id`를 `runtime_execution` 및 terminal Assurance까지 연결하고, 선택 사건에 Work·실행·모델 계보를 남깁니다.
- `REQ-PLACEMENT-002`: 전략 수립 단계가 각 과제의 난이도 신호와 다섯 작업 성격 중 하나를 기록합니다. 작업 축의 표본이 부족하면 역할 baseline으로 되돌리고, Governance 위험과 분리된 계약을 사용합니다.
- `REQ-PLACEMENT-003`: T0·T1·T2 근거와 기준 모델을 권한별로 보존합니다. capability는 하드 gate로 탈락시키고, 같은 평가 bundle·receipt 집합 안에서만 후보를 비교하며 만료·표본·개선폭·보존 gate를 정책 유무와 관계없이 적용합니다.
- `REQ-PLACEMENT-004`: 실행 시점 선택을 기존 Router와 연결하고 `model.route.selected`를 발행합니다. 실행 전 T1 예상 호출 수·최대 비용·Provider·데이터 종류를 표시하며, 서버 계산 관찰을 Growth의 기존 Assurance 채택·revert 흐름에 연결합니다.

## 4. 완료 조건

1. `route_attempt`에서 `assurance_check`까지 실행·모델·Work 계보를 조회할 수 있고, 재시작·fallback 뒤에도 같은 정본을 가리킵니다.
2. 전략 과제의 난이도·작업 성격 신호가 저장되고, 희소 축은 역할 baseline으로 결정론적으로 회귀합니다. 역할 key와 활성 pointer의 기존 계보가 바뀌지 않습니다.
3. 다섯 작업 성격과 T0·T1·T2 receipt가 같은 bundle 기준으로 비교되며, capability gate·만료·표본·개선폭·보존이 fail-closed로 검증됩니다.
4. 모든 선택이 `model.route.selected`와 실제 `route_attempt`에 기록되고, T1 비용·전송 사전 고지와 T2 강등·복구가 동작합니다. 기존 Assurance 독립 신호 없이 자동 채택하지 않습니다.
5. Phase 30 표면 계약을 통과한 화면에서 배치 후보·선택 근거·예상 비용을 확인할 수 있고, 문서·테스트·근거가 현재 source commit에 연결됩니다.
