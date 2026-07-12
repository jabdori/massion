# Phase 27 — 깨끗한 Massion Core 저장소 전환 설계

> **상태**: approved
> **결정일**: 2026-07-13
> **실행 조건**: Phase 24 완료, 전체 품질·보안·설치 gate 통과, 검증된 하나의 source commit 고정
> **현재 판정**: Phase 24의 실제 계정·사용자 시나리오 검증과 전체 gate가 남아 있어 전환을 시작하지 않음

## 1. 결정

제품 전환 순서는 다음으로 고정합니다.

> Phase 24 완료 → 새 비공개 `massion` Core 저장소 전환 → 새 저장소에서 Phase 25 구현 → 개인용 제품 출시 → 실제 Cloud 사업 요구가 생기면 `managed-service` 분리

이 단계는 이전 Git 역사에서 작업을 계속하는 기간을 줄이고, 검증되지 않은 Phase 25 코드와 아직 존재하지 않는 Cloud 사업 시스템을 새 Core에 섞지 않기 위한 전환 단계입니다.

## 2. 지금 하는 일과 미루는 일

### 지금 하는 일

1. Phase 24의 연결 누락, 승인 안전성, 복구, 실제 계정 검증을 완료합니다.
2. lint, typecheck, test, build, 문서, 비밀 검사, 설치·백업 복원 검증을 모두 통과시킵니다.
3. 통과한 하나의 source commit과 tree digest를 고정합니다.
4. 허용 목록의 현재 제품 코드·테스트·운영 문서·Phase 문서만 새 디렉터리로 내보냅니다.
5. 새 비공개 `massion` 저장소에서 하나의 root commit을 만듭니다.
6. 빈 디렉터리의 clean clone에서 설치, 테스트, build, 백업 복원을 다시 검증합니다.
7. 기존 저장소는 삭제하지 않고 private read-only archive와 Git bundle로 보존합니다.

### 지금 하지 않는 일

- `managed-service` 저장소 생성이나 skeleton 생성
- 관리형 사용자·조직, 결제, 요금, 사용량, 상용 권리 발급
- fleet 관리, 관리형 백업·관측, SSO·SCIM·SLA
- Cloud 전용 데이터베이스, URL, package, CI, 계약 package 추출
- Personal Free·Team·Cloud의 최종 라이선스나 상용 권리 구현

Cloud 고객, 과금, 운영, 지원 책임이 실제로 결정된 뒤에만 별도 Phase에서 이 경계를 설계합니다. 현재 Cloud를 미루는 것은 제품 기능을 숨기는 일이 아니라, 아직 근거가 없는 사업 시스템을 미리 고정하지 않는 범위 관리입니다.

## 3. Core에 유지할 최소 Cloud 대비

새 Core는 Cloud 기능을 포함하지 않되 다음 불변식은 유지합니다.

- Application API와 event schema에는 명시적인 버전이 있습니다.
- 외부 서비스는 공개 Application API를 통해 Core와 통신할 수 있습니다.
- Core는 Cloud package, Cloud database, 결제 서버, Cloud URL, 사업 규칙에 의존하지 않습니다.
- 로컬·자체 호스팅의 비밀정보와 구독 token은 사용자의 명시적 동작 없이 그 경계 밖으로 전송하지 않습니다.
- Cloud가 필요해져도 Core 내부 store·SurrealDB record·사용자 home을 직접 가져갈 수 없습니다.

이는 Cloud 분리 구현이 아닙니다. 나중에 분리할 수 없게 Core를 묶어 버리는 의존성만 방지하는 최소 조건입니다.

## 4. 전환 입력과 제외 규칙

전환 도구는 dirty working tree를 입력으로 받지 않습니다. 고정 commit만 읽고, [전환 허용 목록](./transition-allowlist.md)의 파일만 복사합니다.

반드시 제외하는 항목은 다음과 같습니다.

- 기존 `.git`, worktree metadata, remote, reflog, tag, Git object
- Pi·legacy-lineage 및 대체된 제품 계보 문서와 코드
- build 산출물, cache, coverage, 로그, 임시 파일, 의존성 설치 디렉터리
- secret, credential, 개인 경로, 로컬 데이터, 실제 계정 profile
- Cloud 사업 코드·URL·데이터베이스·결제·가상 entitlement 구현

현재처럼 변경 파일과 새 파일이 남아 있는 tree는 전환 대상이 아닙니다. Phase 24를 하나의 깨끗한 검증 commit으로 닫은 뒤에만 export합니다.

## 5. 검증과 복구

새 저장소에서 다음을 증명해야 합니다.

- root commit 하나만 있고 이전 Git object·remote·금지 경로가 없습니다.
- frozen install, lint, typecheck, test, build, 문서·비밀 검사가 통과합니다.
- 깨끗한 clone에서 설치형 서버·CLI·TUI·Web이 시작됩니다.
- 고정한 기존 backup을 새 Core build에서 복원하고 migration checksum, 조직·업무·기록·Extension 정본을 비교합니다.
- 실패 시 새 저장소를 배포하지 않고 기존 private archive로 되돌릴 수 있습니다.

기존 저장소는 전환 완료 뒤에도 삭제하지 않습니다. source commit, tree digest, 파일별 기존·새 경로 또는 제외 사유, export 도구 버전, 검증 영수증을 archive manifest로 남겨 향후 문제를 추적합니다.

## 6. 라이선스와 공개 범위

“개인용은 무료, 팀과 Cloud는 유료”는 Cloud 분리와 별개인 제품·법률 결정입니다. 새 Core를 즉시 공개 배포하지 않으므로, 이 단계에서 라이선스나 팀 상용 권리의 구현을 추측으로 확정하지 않습니다.

새 `massion` 저장소는 우선 비공개로 시작합니다. 개인용 제품 검증이 끝나고 공개 직전에만 소유자가 라이선스, package 공개 범위, 팀 유료 권리와 배포 정책을 결정합니다.

## 7. 요구사항과 완료 조건

- `REQ-REPO-001`: 검증된 source commit의 허용 목록만 새 Git 객체 저장소에 가져오고, 과거 기록은 private archive manifest로 추적합니다.
- `REQ-REPO-002`: 새 Core는 깨끗한 clone의 설치·검증·backup 복원을 통과합니다.
- `REQ-REPO-003`: Phase 25는 새 Core root commit 이후에만 시작합니다.
- `REQ-CORE-BOUNDARY-001`: Core API/event version과 로컬 비밀 경계를 유지하며 Cloud 전용 의존성은 0건입니다.

완료 조건은 Phase 24 전체 gate 통과, source commit 고정, 새 비공개 root commit 생성, clean clone 검증, backup 복원, archive manifest 보존입니다. Cloud 저장소·Cloud 기능·개인 무료 라이선스 구현은 이 Phase의 완료 조건이 아닙니다.
