# Phase 25 — 모델 평가실과 역할별 자동 배치 구현 계획

> **상태**: in-progress
> **상세 계획**: `docs/superpowers/plans/2026-07-13-model-optimization-lab.md`
> **선행 조건**: Phase 24의 구현·로컬 검증 완료, 외부 계정 UAT는 별도 미결 조건이며 Phase 27의 새 Massion Core root commit 생성
> **방법**: 각 항목에서 실패 테스트 확인→최소 구현→관련 회귀 검증→커밋 순서를 지킵니다.

## Task 1. 평가 정본과 역할별 평가 묶음

- [x] `@massion/model-optimization` package와 append-only migration을 추가했습니다.
- [x] 평가 묶음·실행·점수 영수증·정책·추천·배치·관찰·결정 정본을 TDD로 구현했습니다.
- [x] 코어 역할 8개와 소프트웨어 개발 실행 역할 8개의 안정적인 role key와 hard gate 계약을 고정했습니다.

## Task 2. 후보 자격과 격리 평가 실행

- [x] 연결된 모델의 실제 기능을 최소 호출로 검사하고 불일치를 fail closed합니다. 서버가 Router·AI SDK 기반 Provider 실행 adapter를 `ModelEvaluationExecutor`에 연결하며, 실행 실패는 영수증을 완료하지 않고 fail closed합니다.
- [x] 고정된 입력·도구·환경 checksum과 반복 정책을 전달하고 결과를 불변 receipt로 집계하는 평가 실행기를 구현했습니다.
- [x] 그림자 실행에 파일·메시지·배포·승인·조직 정본 변경 capability를 모두 `false`로 전달하는 테스트를 추가했습니다.

## Task 3. 채점과 역할별 배치 추천

- [x] 오류 상태와 품질 실패를 분리하고 하드 게이트·결정론적 채점을 구현했습니다.
- [x] 다섯 가지 사용자 정책에 따라 성공 작업당 비용·품질·속도·개인정보를 결정론적으로 비교합니다.
- [x] 주 모델과 fallback 순서, 근거 영수증, 제외 사유를 포함한 추천을 생성합니다.

## Task 4. 선택적 실사용 학습과 안전한 승격

- [x] 조직별 동의·예산·보존·redaction을 지키는 실사용 관찰을 구현했습니다. `production learning` 명시 동의, 정책별 예산 초과 거부, observation 만료 시각, 불변 observation을 적용합니다.
- [x] 최초 승인, 그림자 실행, 제한 배치, 정책 기반 최소 표본·개선 폭 게이트와 degraded 관찰 복구를 불변 배치 버전으로 구현했습니다.
- [x] 활성 포인터를 transaction 안에서 원자적으로 전환하고 재시작 후 DB에서 다시 읽도록 구현했습니다.

## Task 5. Runtime·Application·사용자 화면

- [x] Runtime이 역할별 활성 배치의 주 모델·fallback 선호 순서를 Router reserve에 전달하게 했습니다.
- [x] 평가 실행·추천·적용·자동화·복구 Application operation과 redacted query를 추가했습니다.
- [x] CLI·TUI·Web의 평가 실행·승인 화면을 동일한 redacted Application operation으로 조립했습니다. CLI/Application과 Web의 실행·변경·승인 흐름, TUI의 조회와 허용 목록 기반 JSON 변경 modal을 연결합니다.
- [x] 서버 bootstrap에서 로컬 OpenAI 호환 모델을 실제로 평가하고 receipt·추천까지 만드는 제품 경계 회귀 테스트를 추가했습니다(`apps/server/src/model-optimization-product.test.ts`).

## Task 6. 외부 평가 연동과 제품 조립

- [x] 외부 평가 결과의 schema version·license·설정 checksum·bundle/case 계보를 검증하는 선택적 import/export 경계를 제공합니다. CLI와 Application operation으로 연결합니다.
- [x] 설치형 서버 bootstrap과 로컬 lifecycle의 Application 구성 및 백업 대상 DB 정본에 평가실을 조립했습니다.
- [x] 확장이 역할 식별자·버전·SHA-256 체크섬·handler를 가진 평가 묶음을 manifest에 선언하고, Extension host가 이를 격리된 contribution registry에 등록하게 합니다. Core optimizer의 고정 role key 집합과 Extension worker의 외부 역할은 경계를 유지합니다.

## Task 7. 실제 사용자 검증과 릴리스 판정

- [ ] Phase 24 release 설치를 `tmux`에서 실행하고 실제 연결 가능한 Provider 역할별 빠른 평가를 검증합니다. 2026-07-14 Codex OAuth·계정·quota·정책 조회는 통과했지만 실제 subscription run이 180초 network timeout으로 남아 있어 역할별 평가를 완료로 표시하지 않습니다. 근거는 `docs/evidence/phase-24/subscription-uat-2026-07-14.md`입니다.
- [ ] 추천 승인·유지·자동 최적화·shadow·승격·rollback·재시작을 비밀이 제거된 영수증으로 검증합니다.
- [x] 전체 검증, 요구사항 추적표, 아키텍처와 운영 문서의 로컬 결과를 현재 source commit에 고정했습니다.
- [ ] 실제 Provider UAT와 redacted receipt가 확보되면 Phase 25 최종 회고를 닫습니다.

## 현재 남은 완성 조건

1. Provider 연결을 실제로 호출하는 평가 executor adapter와 역할별 평가 case 입력 경계는 구현되었습니다. 서버 adapter는 Router reservation·VoltAgent AI SDK 호출·usage/cost 정산·기대 결과 포함 여부 기반 품질 판정을 수행합니다. 실제 Provider별 품질 분포는 외부 계정 UAT에서 추가 확인해야 합니다.
2. 자동 승격 조건과 관찰 redaction의 운영 증거를 추가합니다.
3. TUI 변경 modal·외부 평가 import/export를 실제 release에서 반복해 증거로 고정합니다.
4. Claude·Codex·GLM 및 복수 계정이 실제로 연결된 환경에서 tmux receipt를 갱신합니다.
