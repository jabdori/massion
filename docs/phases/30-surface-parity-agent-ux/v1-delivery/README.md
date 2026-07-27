# 개인용 AgentOS v1 전달 기록

> **상태:** 진행 중
> **독자:** 다음 구현자·검증자
> **정본 계획:** [Phase 30 제품 통합 계획](../../../superpowers/plans/2026-07-24-phase-30-product-integration.md)

이 디렉터리는 구현 계획을 다시 쓰지 않습니다. 각 페이즈에서 실제로 바뀐 경계, 실행한 검증 명령, 남은 진입 조건을 기록해 작업을 안전하게 이어받기 위한 인계 기록입니다.

## 기록 원칙

- 완료는 커밋과 재실행 가능한 검증 결과가 함께 있을 때만 적습니다.
- 사용자 경로·자격증명·토큰은 문서에 쓰지 않습니다. 경로가 필요한 경우 workspace 이름 또는 상대 경로만 씁니다.
- 실패는 최초로 어긋난 공통 계층과 재현 명령만 기록합니다. 해결 전에는 성공으로 표현하지 않습니다.
- 자동 테스트는 경계·회귀를, 실제 Tauri 사용자 인수 테스트(UAT)는 OS 대화상자와 화면 연결을 증명합니다.

## 페이즈

| 페이즈 | 범위 | 상태 | 기록 |
|---|---|---|---|
| 01 | 홈의 워크스페이스·파일 문맥 | 코드 검증 완료 · native UAT 대기 | [페이즈 01](./phase-01-workspace-context.md) |
| 02 | 네이티브 폴더·파일 선택 | 실제 folder/file panel 호출·취소 증분 확인 · 파일 선택·전체 native UAT 대기 | [페이즈 02](./phase-02-native-context-picker.md) |
| 03 | 지식 그래프·검색·기억의 업무 연결 | 진행 중 | [페이즈 03](./phase-03-knowledge-memory.md) |
| 04 | Core·협업·조직·개선·권한·수신함 정합화 | 부분 진행 — Core UAT·Growth review/adoption·재시작 계보 정합화·effect worker 정렬 결함·verifier 독립성 수정·timeout/fallback·Work 오류 가시성·Provider capability/fallback·bundled runtime 증분; 실제 effect cohort는 `stable/retained`까지 확인했으며 전체 UAT는 대기 | [페이즈 04](./phase-04-core-collaboration-permission-inbox.md) |
| 05 | 실제 데스크톱 UAT와 개인용 릴리스 후보 | 제품 후보 `573297642`에서 workspace·native folder/file panel 호출과 실제 Provider Work·재시작 보존을 증분 확인 · 파일 선택·전체 native UAT·릴리스 게이트 대기 | [기존 Tauri/API UAT](../../../evidence/phase-30/desktop-live-tauri-uat-2026-07-26-e3b5fe883.md), [workspace 경계 UAT](../../../evidence/phase-30/desktop-live-workspace-directory-uat-2026-07-26-40a6ffbc8.md), [folder/file panel 증분](../../../evidence/phase-30/desktop-live-native-picker-uat-2026-07-26-40a6ffbc8.md), [제품 후보 file panel](../../../evidence/phase-30/desktop-live-native-file-panel-uat-2026-07-26-573297642.md), [Provider Work·재시작 보존](../../../evidence/phase-30/desktop-live-provider-restart-uat-2026-07-27-573297642.md) |

## 릴리스 전 데이터 보존 gate

- 호환 불명 local data epoch에서 기존 데이터를 자동 삭제하지 않고, 명시적 migration 또는 복구를 요구하는 공통 gate를 구현하고 자동 테스트로 검증했습니다.
- 실제 업데이트·제거·재설치 UAT는 아직 실행하지 않았습니다.

## 증거 위치

실제 앱 조작, 스크린샷, 빌드·설치 결과는 [Phase 30 증거](../../../evidence/phase-30/)에 별도 기록합니다. 이 디렉터리는 증거의 해석과 다음 작업의 진입 조건만 보관합니다.
