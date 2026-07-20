# Phase 30 — Core Office Assurance handoff 계획

- [x] Core Office·Assurance·Work·Records의 실제 차단 지점을 확인했습니다.
- [x] 자동 binding, 순서 보장, 판정 투영의 실패 테스트를 추가했습니다.
- [x] 일반 계획의 evidence 기준만 안전한 자동 binding으로 생성합니다.
- [x] 개인 기본 정책은 자동, 조직 정책은 승인 대기를 유지합니다.
- [x] run 전이와 Work verification 투영을 정상 경로에 연결합니다.
- [x] 일반 검사 후 coverage 검사가 실행되도록 순서를 고정합니다.
- [x] 재개·취소 시 verifier와 Assurance run의 상태 경계를 고정합니다.
- [x] Intake·계획 수립·Delivery의 취소 신호를 Runtime까지 전달하고, 실행 기록·모델 lease·코드 제안 경합을 회귀 테스트로 고정합니다.
- [x] 실제 HTTP product 흐름이 `completed`까지 가는지 검증합니다.
- [x] Core·Strategy·Runtime·Assurance·Records·Server 대상 회귀 테스트와 타입 검사를 통과합니다.
- [x] Z.AI Coding Plan의 route 조립·JSON object 전환·Core 완료 계약을 [로컬 HTTP 계약 테스트](../../evidence/phase-30/zai-core-office-uat-2026-07-20.md)로 기록했습니다.
- [x] 설치된 Software Engineering 조직이 실제 Git 변경과 독립 Assurance를 완료하는 제품 테스트를 고정했습니다.

각 구현 조각은 실패 테스트 → 최소 구현 → focused test 순서로 진행합니다. 전체 품질 게이트는 연결된 사용자 흐름이 완성된 뒤 한 번 실행합니다.
