# ADR-003 — 작업 인지 모델 배치

[English](ADR-003-task-aware-model-placement.md) | [한국어](ADR-003-task-aware-model-placement.ko.md)

> **상태:** 승인됨
> **승인일:** 2026-07-28
> **대상:** 전략·모델 평가실·라우터·실행 계보

## 맥락

헌법 §4.12는 단순 수정에는 가벼운 모델을, 설계·판단에는 강한 추론 모델을 배치하라고 선언했습니다. 그러나 현재 모델 선택 입력은 역할을 나타내는 `agentHandle` 하나뿐입니다(`apps/server/src/product.ts:490-499`). 전략 과제 schema에는 난이도 필드가 없고(`packages/context-strategy/src/strategy-schema.ts:43`), 라우터의 `ModelProfile`에는 추론 등급이나 속도 계약 없이 `eval_score`만 있습니다(`packages/router/src/model-router.ts:48-67`). 다섯 Core route도 같은 파라미터로 생성됩니다(`apps/server/src/server-model-route-assembler.ts:38-60`). 호출부는 `modelRoute`를 하드코딩합니다(`packages/application/src/core-pipeline.ts:426`, `packages/application/src/core-delivery-stage.ts:298`, `packages/application/src/core-assurance-stage.ts:286`, `packages/application/src/core-software-task.ts:291`, `apps/server/src/growth-worker.ts:740`).

이 저장소 659개 커밋의 전수 `git log -S` 조사에는 난이도 기반 선택 구현이 없었습니다. 헌법 §4.12는 `e9f0ef4`에서 Phase 25 구현 커밋(`4740f1a`, `fd4f243`)보다 9일 뒤 처음 들어왔습니다. 선행 프로젝트의 모델 선택 계보는 새 저장소에 들어오지 않았고, Phase 27도 이를 가져오지 않았습니다(`docs/product/constitution.md:73`). Phase 25 최초 계획의 빠른·정밀 평가와 독립 채점 요구는 `9a6b137`에서 안정적인 role key와 결정론적 채점으로 축소되었습니다. 따라서 이번 결정은 헌법이 선언했으나 구현된 적 없는 기능의 최초 구현을 위한 것입니다.

현재 평가실의 정본도 바로 배치를 신뢰할 만큼 닫혀 있지 않습니다. 후보마다 최신 영수증을 따로 고르는 경로는 서로 다른 bundle을 비교할 수 있고(`packages/model-optimization/src/scoring.ts:129`), 표본·개선폭 gate는 policy 레코드가 있을 때만 실행됩니다(`packages/model-optimization/src/batch.ts:275`). 관찰의 품질·지연·비용을 호출자가 보내며(`packages/model-optimization/src/batch.ts:160`), `expires_at`은 저장되지만 조회에서 집행되지 않습니다(`packages/model-optimization/src/batch.ts:482-498`). Growth 제안 대상에도 model batch가 없고(`packages/growth/src/reflection.ts:17`), `route_attempt`에는 실행 정본을 잇는 `execution_id`가 없습니다.

## 결정

### 1. 난이도는 역할 키에 섞지 않습니다

역할×난이도 조합으로 `OptimizationRoleKey`를 늘리는 안은 역할 키를 16개에서 16K개로 폭발시키고, 역할이 bundle checksum에 포함되는 기존 계보(`packages/model-optimization/src/evaluation.ts:359`)를 끊으므로 기각합니다. 배치에 난이도별 tier를 넣는 안도 배치 정본이 매 작업의 변동값을 소유하게 만들어 추천·배치 checksum을 함께 바꾸므로 기각합니다.

역할별 배치는 후보 집합만 제공합니다. 전략이 과제의 난이도 신호를 만들고, 실행 시점의 작업 축이 그 후보 안에서 모델을 고릅니다. 활성 포인터는 역할별로 하나만 두고, 관찰에 작업 축을 기록합니다. 축별 표본이 부족하면 역할 baseline으로 되돌립니다. 활성 포인터를 역할×난이도로 쪼개지 않아 희소 조합이 영원히 승격되지 않게 합니다.

### 2. 신호는 전략 수립 단계가 만듭니다

`strategyTaskSchema`에 과제별 난이도 선택 필드를 추가합니다. 전략 생성기는 목표·범위·제약·가정·미지수·결정·근거·담당자를 이미 입력받아 과제를 분해하므로(`packages/context-strategy/src/strategy-generator.ts:243`) 판정 문맥이 있습니다. 실행 직전의 단일 WorkTask 투영은 이 문맥을 잃습니다(`packages/application/src/core-delivery-stage.ts:192`).

Governance의 `riskClass`와 `strategyRiskSchema`의 likelihood·impact는 행동·계획 위험을 뜻하므로 추론 요구량에 재사용하지 않습니다. 같은 low·medium·high 어휘를 쓰더라도 별도 필드와 별도 계약으로 둡니다.

### 3. 벤치 축과 근거 권한을 고정합니다

벤치의 작업 성격 축은 코드 생성, 코드 이해·설명, 계획·설계, 검토·비판, 요약·기록의 다섯 가지입니다. 역할과 직교하므로 같은 역할의 서로 다른 일을 구분합니다. 긴 문맥·도구·구조화 출력·비전은 점수 축이 아니라 하드 gate입니다.

근거는 세 층입니다.

- T0 동봉 벤치는 만료 시각이 있는 콜드스타트 사전 추정이며 정본이 아닙니다. 로컬 증거가 생기면 밀려납니다. 외부 리더보드가 Massion 평가와 실사용 검증을 대체하지 않도록 license·오염 가능성·버전·실행 설정을 receipt에 고정합니다.
- T1 클라이언트 로컬 벤치는 동봉 목록 밖 모델을 통제된 조건에서 측정해 승격 근거로 쓸 수 있습니다. 실행 전 예상 호출 수·최대 비용·전송 대상 Provider와 데이터 종류를 보입니다.
- T2 실제 Work 관찰은 Assurance 판정을 신호로 쓰되 초기에는 순위 상승이 아니라 강등·복구에만 씁니다. 쌍별 shadow 비교는 사용자가 명시적으로 켠 경우에만 별도 예산으로 실행합니다.

사용자는 자신이 가진 모델 중 가장 강한 기준 모델을 최초에 지정합니다. 이는 요청별 모델 선택기가 아니라 자원 신고이며, 상대 채점의 기준입니다. 기준 모델 판정은 `model-self` 보조 신호로만 쓰고, `origin='independent'`인 Assurance 신호를 요구하는 기존 채택 gate(`packages/growth/src/schema.ts:477`, `packages/growth/src/evaluation.ts:132`)를 우회하지 않습니다. 새 채점기를 만들지 않고 `apps/server/src/growth-worker.ts:486-551`의 terminal Assurance 3건 효과 측정과 악화 시 자동 revert 기계를 재사용합니다.

### 4. 계보를 먼저 잇습니다

`route_attempt.execution_id`를 추가해 `assurance_check.executor_execution_id` → `runtime_execution.execution_id` → `route_attempt.execution_id` → `route_attempt.model_profile_id` 사슬을 완성합니다. 이 연결 없이는 어느 벤치·Work·Assurance가 어느 모델을 사용했는지 확인할 수 없습니다. 그 다음에만 전략 신호, 후보 선택, 관찰, 표면을 연결합니다.

## 결과

역할 bundle의 checksum과 기존 후보·정책·라우터 계약은 유지합니다. 실행기는 역할 배치의 후보 집합과 작업 신호를 받아 모델을 선택하고 `model.route.selected`를 기록합니다. 작업 축별 표본이 없으면 역할 baseline을 사용하며, 사용자에게 요청마다 모델을 고르게 하지 않습니다.

T0·T1·T2의 출처와 만료·비용·데이터 전송 범위가 선택 근거에 남습니다. 관찰은 서버가 계산한 품질·지연·비용과 실제 실행·모델을 잇고, 보존 기간과 policy 부재 시 gate도 적용합니다. 모델 batch는 Growth 제안 대상과 route lineage를 갖습니다.

Phase 30은 아직 `in-progress`이므로 이 ADR의 실행 표면은 그 기능 동등화 작업과 함께 검증합니다. 본 결정의 구현·검증 계획은 [Phase 31 설계](../phases/31-task-aware-model-placement/design.md)와 [구현 계획](../phases/31-task-aware-model-placement/implementation-plan.md)이 소유합니다.

## 대안과 기각 이유

- 역할 키를 역할×난이도로 확장 — key·checksum 계보가 불필요하게 폭발합니다.
- 배치 안에 난이도 tier를 저장 — 작업마다 달라지는 값을 배치 정본에 넣어 추천·checksum을 흔듭니다.
- 실행 직전에 난이도를 새로 판정 — 단일 WorkTask 투영에는 전략의 근거가 부족합니다.
- Governance risk를 난이도로 재사용 — 위험한 행동과 높은 추론 요구량은 다른 축입니다.
- 활성 포인터를 역할×난이도로 분할 — 희소 조합이 승격되지 못하고 baseline 회귀도 어렵습니다.
- 외부 리더보드나 기준 모델만으로 자동 채택 — 독립 Assurance gate와 실제 Work의 불확실성을 대체할 수 없습니다.
