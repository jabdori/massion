# Phase 27 — 깨끗한 Massion Core 저장소 전환 구현 계획

> **상태**: planned
> **설계**: `docs/phases/27-clean-repository-cloud-separation/design.md`
> **선행 조건**: Phase 24 완료와 전체 gate 통과
> **방법**: 고정 source 확인 → 결정론적 export → 새 root commit → clean clone 검증 → archive 회고

## Task 1. Phase 24 기준점 고정

- [ ] Phase 24의 실제 계정·tmux 사용자 시나리오와 전체 lint·typecheck·test·build·문서·비밀·설치 gate를 통과시킵니다.
- [ ] 변경 없는 source commit 하나와 tree digest를 고정합니다.
- [ ] 전환 당시의 사용자 승인, Phase 24 회고, 요구사항·테스트·검증 영수증을 archive 입력으로 고정합니다.

## Task 2. 결정론적 Core export

- [ ] 허용 목록과 제외 목록을 검사하는 export 도구의 실패 테스트를 작성합니다.
- [ ] dirty tree, `.git`, secret, 개인 경로, build 산출물, Pi·legacy-lineage 계보와 Cloud 전용 항목을 거부합니다.
- [ ] 파일별 SHA-256, 기존 경로, 새 경로 또는 제외 사유를 가진 private archive manifest를 생성합니다.

## Task 3. 새 비공개 Core root commit

- [ ] 격리된 새 디렉터리에 허용 목록만 내보내고 새 `.git`을 초기화합니다.
- [ ] 새 비공개 `massion` 저장소의 첫 root commit을 만듭니다.
- [ ] 새 tree에 이전 Git object·remote·금지 이름·금지 경로가 없는지 검사합니다.

## Task 4. clean clone·복원 검증

- [ ] 빈 디렉터리에 clone한 뒤 frozen install, lint, typecheck, test, build와 문서·비밀 검사를 실행합니다.
- [ ] 설치형 서버, CLI, TUI, Web과 Phase 문서 추적 경로를 검증합니다.
- [ ] 기존 최신 backup을 복원하고 migration checksum과 핵심 정본을 비교합니다.

## Task 5. archive와 다음 Phase 인계

- [ ] 기존 저장소와 Git bundle을 private read-only archive로 보존하고 manifest·검증 영수증을 연결합니다.
- [ ] Phase 25 구현 시작점이 새 Core root commit임을 기록합니다.
- [ ] 실제 결과와 source/root commit digest, 복구 결과, 제외 사유를 Phase 27 회고에 남깁니다.

Cloud 저장소, 결제, 관리형 운영, Cloud 계약 package, 라이선스와 팀 상용 권리 구현은 이 계획에 포함하지 않습니다. 실제 Cloud 사업 요구가 확정되면 새 Phase를 승인해 별도로 시작합니다.
