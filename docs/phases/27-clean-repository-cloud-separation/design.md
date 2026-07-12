# Phase 27 — 이력 보존형 깨끗한 Massion Core 저장소 전환 설계

> **상태**: approved
> **결정일**: 2026-07-13
> **변경 근거**: 새 Core에서 즉시 개발을 계속하되, 이력서와 문제 추적에 필요한 Massion 개발 커밋은 보존합니다.
> **입력 기준**: export 시작 직전의 clean `feat/massion-1.0-productization` HEAD. 정확한 hash는 archive manifest에 기록합니다.

## 1. 결정

전환 순서를 다음으로 변경합니다.

> 깨끗한 비공개 `massion` Core 저장소 전환 → 새 저장소에서 Phase 24 검증 재개·완료 → Phase 25 구현 → 개인용 제품 출시 → 실제 Cloud 사업 요구가 생기면 `managed-service` 분리

새 저장소는 과거 Pi·legacy-lineage 저장소의 Git 객체·브랜치·원격을 복사하지 않습니다. 다만 Massion의 구현 시작점부터 현재까지의 의미 있는 제품 개발 커밋 메시지와 변경 계보는 보존합니다.

## 2. 보존할 개발 이력의 경계

### 2.1 원본 범위

- 시작 commit: `9946b8a` — `build(massion): Phase 1 monorepo 품질 기반 구축`
- 구현 기준 종료 commit: `226aa5e` — `fix(massion): contain release runtime symlinks`
- 원본 Massion 구현 범위: 262개 commit

이 시작점부터 구현 기준 종료 commit까지 262개 commit의 제목·본문을 `legacy-lineage`, `legacy-source`, `managed-service`, Cloud billing·SSO·SCIM 용어로 검사한 결과는 0건입니다. 전환 설계·검증을 기록하는 후속 Phase 27 commit은 같은 허용 경로·금지어 검사 후 추가합니다. Phase 0 이전의 17개 설계·계보 commit은 이력 보존 범위에 넣지 않습니다. 그 구간에는 legacy-lineage 계승 자료가 있습니다.

### 2.2 새 저장소에서의 실제 보존 규칙

- `git filter-repo`가 허용 경로를 건드린 commit만 새 commit으로 재작성합니다.
- 허용 경로가 전혀 없는 문서 전용 commit은 빈 commit으로 남기지 않고, private archive manifest에 원본 hash·제목·제외 사유를 기록합니다.
- 새 hash는 원본 hash와 다릅니다. archive manifest의 one-to-one 또는 pruned 매핑이 문제 추적의 정본입니다.
- 원본 branch, remote, tag, reflog, Git object, `.git/refs/.DS_Store` 같은 손상·개인 로컬 항목은 새 저장소에 전송하지 않습니다. 원본 저장소는 수정하거나 삭제하지 않습니다.

이 방식은 이력서에 유용한 실제 `feat`, `fix`, `test`, `docs`, `ci` 제품 개발 이력을 남기면서 과거 제품의 파일·Git 객체를 새 Core로 들여오지 않습니다.

## 3. 새 Core의 파일 경계

모든 과거 commit과 최종 HEAD에 다음 경로만 허용합니다.

- 제품 코드·테스트: `apps/`, `packages/`, `extensions/`, `scripts/`, `release/`, `deploy/`
- 현재 운영·추적 문서: `docs/architecture/`, `docs/operations/`, `docs/evidence/phase-24/`, `docs/phases/24-native-subscription-connectors/`, `docs/phases/25-model-optimization-lab/`, `docs/phases/26-gpt-5-6-migration/`, `docs/phases/27-clean-repository-cloud-separation/`
- 루트 정본: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.dockerignore`, `.prettierignore`, `.prettierrc.json`, `.gitignore`, `compose.yaml`, `Dockerfile`, `README.md`, `CHANGELOG.md`, `.github/`

다음은 현재 HEAD뿐 아니라 새 Git history 전체에서 제외합니다.

- Pi·legacy-lineage·대체 제품 계보 코드·문서·브랜드·조사 기록
- `docs/history/`, `docs/facts/`, `docs/superpowers/`, 과거 Phase 0~23 문서
- build 산출물, cache, coverage, log, `node_modules/`, 백업 원문, 실제 계정 profile
- secret, credential, 개인 경로, 원본 `.git`과 모든 worktree metadata
- Cloud 사업 코드·URL·database·billing·fleet·SSO·SCIM·SLA 자료와 `managed-service`

VoltAgent는 현재 runtime이 직접 사용하는 의존성·소스 식별자이므로, 활성 제품 코드에서의 참조 자체를 과거 Pi 계보로 취급하지 않습니다. 단, 조사 문서와 불필요한 과거 설명은 제외합니다.

## 4. Core와 Cloud의 경계

Cloud 기능은 구현하지 않습니다. 새 Core에는 다음 최소 불변식만 유지합니다.

- Application API와 event schema에는 명시적인 버전이 있습니다.
- 외부 서비스는 공개 Application API로만 Core와 통신합니다.
- Core는 Cloud package, Cloud database, 결제 서버, Cloud URL, 사업 규칙에 의존하지 않습니다.
- 로컬·자체 호스팅의 비밀정보와 구독 token은 사용자의 명시적 동작 없이 외부로 전송하지 않습니다.

개인 무료·팀 유료·Cloud 상용 권리는 공개 배포 직전의 별도 제품·법률 결정입니다. 새 `massion` 저장소와 GitHub 원격은 그 결정 전까지 비공개입니다.

## 5. 전환 절차와 검증

1. 원본 `226aa5e`와 Phase 1 시작점의 reachability, clean status, 허용 경로, 메시지 금지어 검사를 기록합니다.
2. 원본을 수정하지 않는 일회용 복제본에서 허용 경로만 filter-repo로 재작성하고 `massion/` 접두어를 새 저장소 root로 올립니다.
3. 새 로컬 repository에서 history·경로·message·secret·Git object 경계를 검사합니다.
4. archive manifest에 원본·새 commit mapping, pruned commit 사유, 파일 SHA-256, 필터 도구 버전, 검증 결과를 owner-only로 남깁니다.
5. 새 비공개 GitHub `massion` 원격을 연결하고, 빈 디렉터리 clone에서 frozen install, lint, typecheck, test, build, 보안·문서·release 검증을 실행합니다.
6. 이 저장소에서 Phase 24의 tmux 실제 계정 UAT와 회고를 재개합니다.

완료 조건은 새 저장소의 clean clone 검증, source-to-new history mapping, 비공개 GitHub push, 원본 private archive 보존입니다. Phase 24 실제 계정 UAT는 새 저장소에서 계속 실행하며, 이 전환만으로 완료되었다고 표시하지 않습니다.

## 6. 요구사항

- `REQ-REPO-001`: Phase 1부터 현재까지의 허용된 Massion 제품 개발 계보를 새 repository에 재작성해 보존합니다.
- `REQ-REPO-002`: Pi·legacy-lineage·Cloud 사업 자료, 원본 Git object, 비밀·개인 경로·산출물은 새 tree와 history에서 0건입니다.
- `REQ-REPO-003`: archive manifest는 원본 commit과 새 commit 또는 pruned 사유를 추적합니다.
- `REQ-REPO-004`: 새 비공개 GitHub 저장소의 clean clone이 전체 품질·release 검증을 통과합니다.
- `REQ-CORE-BOUNDARY-001`: Core API/event version과 로컬 비밀 경계를 유지하며 Cloud 전용 의존성은 0건입니다.
