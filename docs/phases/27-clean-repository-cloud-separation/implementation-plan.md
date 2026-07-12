# Phase 27 — 깨끗한 저장소 전환과 Cloud 분리 구현 계획

> **상태**: planned
> **설계**: `docs/phases/27-clean-repository-cloud-separation/design.md`
> **선행 조건**: Phase 24·25·26 completed, 전체 출시 gate 통과, 라이선스 법률 검토와 소유자 선택 완료
> **방법**: 실패 검증→최소 계약·도구→격리 import→clean clone 검증→cutover 회고 순서를 지킵니다.

## Task 1. Source 동결과 법적·제품 경계 확정

- [ ] Phase 24·25·26 회고와 전체 lint·typecheck·test·build·보안·release gate 통과를 확인합니다.
- [ ] Personal Free, Team Self-hosted, Massion Cloud의 라이선스·공개 여부·offline entitlement를 법률 검토와 소유자 결정으로 고정합니다.
- [ ] 고정 source commit·tree digest와 파일별 Core·Cloud·제외 분류를 승인합니다.

## Task 2. 공개 계약과 entitlement TDD

- [ ] Application wire·client·Extension·entitlement 계약이 내부 store를 export하지 않는 실패 검사를 작성하고 독립 package로 추출합니다.
- [ ] 한 사람·개인 조직·loopback은 허용하고 팀 생성·두 번째 사람·team mode·공유 계정·팀 배포는 유료 권리 없이 차단합니다.
- [ ] 만료·위조·rollback된 offline entitlement에서 변경·실행은 막고 읽기·backup·export·downgrade는 보존합니다.

## Task 3. 결정론적 clean export 도구

- [ ] 고정 commit만 입력받고 dirty tree, `.git`, secret, artifact, 이전 제품 자료와 Cloud 파일을 거부하는 export 실패 검사를 작성합니다.
- [ ] allowlist·denylist, 파일 SHA-256, 제외 이유와 서명을 가진 private import manifest를 생성합니다.
- [ ] 새 추적표가 과거 Git object 대신 import manifest digest를 검증하도록 문서 검사를 확장합니다.

## Task 4. 두 history-free 저장소 생성

- [ ] 격리된 새 디렉터리에 `massion`을 import하고 새 `.git`과 root commit을 만듭니다.
- [ ] 별도 디렉터리에 `managed-service` 경계·계약 pin·최소 CI·보안 skeleton을 만들고 별도 root commit을 만듭니다.
- [ ] 기존 object·reflog·remote·금지 이름·경로 0건과 Core→Cloud 역의존 0건을 검증합니다.

## Task 5. 라이선스·package·공급망 정합성

- [ ] repository LICENSE/EULA, 모든 npm package metadata와 binary·container·Extension 고지를 승인 결정에 맞춥니다.
- [ ] dependency license, 저작권·기여 provenance, secret scan, SBOM과 source digest를 새 commit에서 생성합니다.
- [ ] package publish와 remote 공개가 선택한 권리·visibility보다 넓어지지 않는지 fail closed합니다.

## Task 6. Clean clone·data·release 검증

- [ ] 두 저장소를 빈 디렉터리에 clone해 frozen install, lint, typecheck, test, build, 문서·보안·강건성 gate를 실행합니다.
- [ ] 기존 최신 backup의 restore, migration checksum, 핵심 정본과 Extension·config upgrade·rollback을 검증합니다.
- [ ] 새 commit으로 설치 artifact·OCI image·SBOM·provenance를 재생성하고 Personal·Team entitlement 사용자 시나리오를 tmux로 검증합니다.

## Task 7. Cutover·회고

- [ ] 새 remote 이름·소유자·visibility·tag·package scope를 소유자 확인 뒤 연결합니다.
- [ ] 전환 실패 rollback과 기존 저장소 read-only private archive·Git bundle 복구를 검증합니다.
- [ ] 요구사항 추적표, 제품·아키텍처·운영 문서와 Phase 27 회고에 source/import/new commit digest와 실제 결과를 연결합니다.
