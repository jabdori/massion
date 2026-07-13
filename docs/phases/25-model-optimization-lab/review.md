# Phase 25 — 모델 평가실 회고와 종료 조건

> **상태**: 외부 Provider UAT 대기
> **대상**: 역할별 모델 평가·추천·배치·실사용 관찰·Extension 경계
> **검토 기준**: `docs/evidence/phase-25/model-optimization-2026-07-13.md`

## 이번 Phase에서 구현한 것

- 평가 bundle·case·run·receipt와 checksum 계보
- Router와 VoltAgent AI SDK를 사용하는 서버 평가 executor
- 품질·비용·속도·개인정보·수동 정책별 결정론적 추천
- 추천 승인, 제한 batch, shadow, 자동 승격 조건, rollback·recovery
- production learning 동의, 관찰 예산·보존 기간·만료 시각
- Application operation과 redacted query
- Application query 경계에서 policy·receipt·recommendation·observation·active batch를 allowlist projection해 adapter가 덧붙인 prompt·credential 필드를 제거
- CLI·TUI JSON mutation modal·Web 정책 화면
- 외부 평가 bundle import/export의 schema·license·configuration checksum 검증
- Extension manifest의 평가 bundle 선언과 worker contribution registry 등록

Core optimizer의 role key 집합은 고정하고, Extension worker의 외부 역할은 별도 RPC 경계에 둡니다. 따라서 확장이 Core 정본을 우회해 임의 모델 배치를 활성화하지 않습니다.

## 검증 결과

전체 `pnpm verify`, 보안 게이트, 하드닝, release build·install·backup·restore·uninstall 검증이 통과했습니다. 모델 최적화 package 20개 테스트와 Extension SDK·host 회귀 테스트가 통과했습니다. 자동 승격 게이트·관찰 예산·보존 만료·복구·import/export는 결정론적 테스트로 확인했습니다.

tmux release 시나리오는 설치 preflight까지 진행했습니다. 실제 Provider 품질 분포와 subscription run은 OAuth·외부 계정 인증이 필요해 성공으로 기록하지 않았습니다.

## 결정과 교훈

1. 실제 provider 품질 점수는 기대 결과 포함 여부와 실행 usage를 기반으로 계산하되, Provider별 품질 분포는 실제 계정 UAT가 있기 전까지 일반화하지 않습니다.
2. production learning은 기본 비활성이고, 명시 동의·예산·보존 정책 없이는 관찰을 저장하지 않습니다.
3. 추천·배치·관찰·복구는 command idempotency와 request hash를 유지해 재전송을 안전하게 처리합니다.
4. 외부 평가 데이터는 prompt 원문과 credential을 export하지 않는 checksum 기반 bundle로 제한합니다.

## Phase 25 종료 조건

다음 조건이 모두 충족되면 Phase를 `completed`로 변경합니다.

1. 사용자 인증이 완료된 실제 Provider에 대해 역할별 최소 평가를 실행하고 receipt를 저장합니다.
2. 추천 승인·자동 최적화·shadow·제한 승격·rollback·재시작을 release 환경에서 redacted receipt로 반복합니다.
3. TUI mutation modal과 외부 bundle import/export를 release 환경에서 반복하고 계보를 기록합니다.
4. Phase 24 최종 receipt와 함께 전체 source·release·문서 계보를 고정합니다.
