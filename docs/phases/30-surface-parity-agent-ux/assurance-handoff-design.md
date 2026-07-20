# Phase 30 — Core Office 완료 기준의 자동 검증 연결

## 결정

Core Office의 계획 조직(Context Strategy)이 만든 완료 기준(acceptance criteria)은 검증 조직(Assurance)이 내부 검사 규칙(binding)으로 자동 변환합니다. 사용자는 binding을 만들거나 선택하지 않습니다.

개인용 기본 정책은 이 내부 활성화를 자동 허용합니다. 조직이 검토 정책을 적용한 경우에만 기존 승인 흐름으로 대기·재개합니다.

## 현재 범위

- 일반 작업은 실제 전달 산출물(artifact version)이 존재·소유·무결·신선한지 검사합니다.
- 모든 일반 검사가 통과한 뒤에만 종합 coverage 검사가 그 결과를 확인합니다.
- Assurance run은 `planned → running → terminal` 순서로 전이합니다.
- 통과·실패 판정은 Work verification으로 투영되어 Records와 최종 완료가 이어집니다.
- 이미 실행 중인 verifier는 다른 재개가 중단시키지 않으며, 대기열 상태만 같은 실행으로 이어 시작합니다.
- 작업 취소는 verifier와 진행 중인 Assurance run을 함께 `cancelled`로 정리합니다.
- 취소 신호는 Intake·계획 수립·Delivery의 Runtime 호출까지 전달합니다. 실행 기록 생성, 모델 lease 획득, 코드 제안 뒤 취소되면 Provider·TDD·후속 상태 변경을 시작하지 않습니다.

## 경계

소프트웨어 변경(code change)은 테스트·보안 검사 실행기가 연결되기 전에는 자동 통과시키지 않습니다. 이 경우 명확히 차단하며, 산출물 존재만으로 테스트나 보안 검증을 주장하지 않습니다.

구독 verifier가 provider 승인으로 중단(suspended)된 경우에는 승인 재개 UX가 연결되기 전까지 명시적으로 차단합니다. 이를 일반 검증 성공이나 자동 승인으로 바꾸지 않습니다.

## 완료 기준

깨끗한 개인용 실행에서 일반 Core 작업이 계획 → 전달 산출물 → 자동 Assurance → Records → `completed`까지 도달하고, 실행 이력에 Assurance가 남아야 합니다.
