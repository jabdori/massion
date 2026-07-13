# Phase 27 — 이력 보존형 깨끗한 Massion Core 저장소 전환 구현 계획

> **상태**: completed
> **설계**: `docs/phases/27-clean-repository-cloud-separation/design.md`
> **방법**: 원본 검증 → 일회용 filter-repo → 이력·경로 검사 → 새 private remote → clean clone 검증 → archive 회고

## Task 1. 원본 기준점과 보존 범위 고정

- [x] 원본 종료 commit `226aa5e`와 시작 commit `9946b8a`를 지정합니다.
- [x] 시작점 이후 262개 Massion 변경 commit의 제목·본문에 legacy 금지어가 없는지 검사합니다.
- [x] 원본 `.git/refs/.DS_Store` 손상 참조를 기록하고, 원본을 수정하지 않는 정책을 고정합니다.
- [x] Phase 24 최종 UAT를 새 저장소에서 다시 실행하고 인계 기록을 남겼습니다.

## Task 2. 결정론적 history filter 절차

- [x] 허용 경로 밖 파일, 절대·상위 경로, Git metadata, secret·개인 경로, legacy 이름을 전환 전 검사에서 거부하고 결과를 기록합니다.
- [x] source range·allowlist·금지어 목록을 고정한 일회용 export 절차를 private archive에 보존합니다. 재사용 export 도구는 제품 Core에 넣지 않습니다.
- [x] `git filter-repo`를 일회용 복제본에서만 실행하고, `massion/` 접두어를 새 root로 재작성합니다.
- [x] 원본 commit → 새 commit 또는 pruned 사유, 파일 SHA-256, 도구 버전의 archive manifest를 생성해 owner-only archive에 보존합니다.

## Task 3. 새 Massion repository 생성

- [x] 새 격리 디렉터리에 history-filter 결과만 둡니다.
- [x] 새 repository의 branch·remote·Git object가 원본 Pi 저장소와 분리됐는지 검사합니다.
- [x] 새 HEAD와 전체 history에 허용 경로 밖 파일·금지어·secret·개인 경로가 0건인지 검사합니다.
- [x] 새 repository를 private GitHub `massion` 원격으로 생성·push합니다.

## Task 4. clean clone 검증

- [x] 빈 디렉터리 clone에서 frozen install, format, lint, typecheck, test, build, 문서·보안·hardening 검사를 실행합니다. 결과는 `docs/evidence/phase-27/clean-clone-verification-2026-07-13.md`에 기록합니다.
- [x] release build와 install·server lifecycle·backup restore 검증을 실행합니다.
- [x] 실패 시 배포하지 않는 게이트를 유지하고, archive manifest와 원본 source commit으로 재현할 수 있도록 검증 기준을 고정합니다.

## Task 5. Phase 24 인계와 Phase 27 회고

- [x] 새 저장소에서 tmux 실제 계정 UAT를 재개하고, receipt를 source/release commit에 묶었습니다.
- [x] source/new commit mapping, clone 검증, 제외 사유, 원본 archive 위치, 남은 UAT를 `review.md`에 기록했습니다.
- [x] Phase 25의 시작점이 새 `massion` repository HEAD임을 기록했습니다.

Cloud 저장소, 결제, 관리형 운영, Cloud 계약 package, 라이선스와 팀 상용 권리 구현은 이 계획에 포함하지 않습니다.
