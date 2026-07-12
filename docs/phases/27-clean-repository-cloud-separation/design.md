# Phase 27 — 깨끗한 저장소 전환과 Cloud 분리 설계

> **상태**: approved
> **결정일**: 2026-07-12
> **실행 조건**: Phase 24·25·26 완료, 전체 출시 gate 통과, 라이선스 법률 검토와 소유자 선택 완료
> **현재 판정**: 선행 조건 미충족으로 구현을 시작하지 않음

## 1. 목적

검증이 끝난 Massion 제품 스냅샷을 기존 Git 역사와 분리된 새 객체 저장소로 재현 가능하게 이관합니다. 설치형 제품과 관리형 Cloud의 코드·배포·사업 경계를 서로 다른 저장소로 고정하고, 무료 범위를 사람 한 명이 사용하는 개인용 제품으로 제한합니다.

이 단계는 기존 저장소에서 파일을 지우는 정리 작업이 아닙니다. 고정한 source commit에서 허용 목록만 결정론적으로 내보내 새 `.git` 객체 저장소의 첫 commit으로 만드는 릴리스 전환(cutover)입니다.

## 2. 확인된 현재 상태

- 2026-07-12 관측 시 현재 역사는 534개 commit이며 최초 root부터 이전 제품 가져오기 계보를 포함합니다. 같은 객체 저장소에서 branch만 바꾸거나 squash하면 과거 객체·reflog·remote가 남을 수 있습니다.
- 제품 tree와 현재 문서에는 이전 프로젝트 계보 설명이 남아 있습니다. 새 제품 저장소에는 실행 코드·현재 정본·운영 문서만 선택적으로 이관해야 합니다.
- 관리형 Massion Cloud 구현 코드는 현재 없습니다. `docs/architecture/README.md`는 관리형 Cloud를 1.0 범위 밖으로 명시합니다.
- 현재 제품은 개인과 팀 자체 호스팅을 함께 구현했지만 루트 `LICENSE`가 없고 workspace package에도 확정된 라이선스 metadata가 없습니다.
- 현재 제품 정본의 “오픈소스 Core” 표현과 사용자의 “무료는 개인용으로 제한” 결정은 그대로 함께 성립할 수 없습니다.

## 3. 변경할 수 없는 결정

1. 새 제품 저장소는 기존 `.git`, worktree, object, reflog, tag와 remote를 복사하지 않습니다.
2. `massion`과 `managed-service`는 서로 다른 Git 객체 저장소와 release lifecycle을 가집니다.
3. Cloud는 versioned Massion 계약과 release artifact를 소비할 수 있지만 Massion Core는 Cloud package·billing endpoint·Cloud database 구현을 import하지 않습니다.
4. 개인 무료 제한은 에이전트 수가 아니라 사람 사용자 수에 적용합니다. 개인 사용자도 Core Office와 여러 전문 에이전트의 전체 협업 기능을 사용합니다.
5. 팀 자체 호스팅과 관리형 Cloud는 상용 권리가 필요한 제품입니다.
6. 라이선스 문구, 공개 여부와 원격 저장소 visibility는 법률 검토와 소유자의 명시적 선택 없이 확정하지 않습니다.
7. 새 저장소 검증이 끝나기 전에는 현재 저장소를 삭제하거나 유일한 복구 근거로 만들지 않습니다.

## 4. 저장소 경계

| 저장소 | 책임 | 포함하지 않는 것 |
|---|---|---|
| `massion` | 로컬 AgentOS, Core Office, 조직·업무·기록, Runtime·Router, CLI·TUI·Web, 로컬 server, Extension SDK·Host, versioned Application wire 계약·client, 일반 entitlement port, 팀 자체 호스팅의 제품 계약 | 관리형 tenant provisioning, billing, fleet 운영, Cloud database 구현, Cloud 전용 secret·URL |
| `managed-service` | 관리형 tenant provisioning, 요금·사용량·상용 entitlement 발급, fleet·배포·upgrade orchestration, managed Registry·backup·observability, SSO/SCIM·기업 감사·SLA | Core 내부 store·repository 직접 import, `workspace:*` 교차 의존, 개인 로컬 비밀과 사용자 home |

허용되는 방향은 `managed-service → semver로 고정된 Massion 계약 package·OCI digest`뿐입니다. Git submodule, 상대 경로 package, Core 내부 모듈 deep import와 양방향 workspace는 금지합니다.

현재 Cloud 구현이 없으므로 Phase 27에서 가짜 기능을 복제하지 않습니다. 대신 별도 `managed-service` 저장소의 첫 commit에는 경계 문서, 소비할 공개 계약 version, 최소 CI·비밀 검사·라이선스 정책만 둡니다. 이후 Cloud 기능은 이 저장소에서만 구현합니다.

## 5. 제품 Edition과 무료 범위

| Edition | 사람·조직 | 배포·네트워크 | Agent 기능 | 권리 |
|---|---|---|---|---|
| Personal Free | 활성 사람 1명, 개인 조직 1개 | 단일 사용자 기기, loopback, 로컬 SurrealDB | Core Office, 전문 Agent, Work, Extension, 개인 모델·구독 계정 전체 | 무료 개인용 |
| Team Self-hosted | 복수 사람, team 조직, 조직 계정 공유 | TLS 원격 server, Compose·Kubernetes, offline 운영 가능 | Personal 기능과 팀 Membership·정책·감사·배포 | 유료 상용 entitlement |
| Massion Cloud | 복수 tenant·조직 | 관리형 control plane과 data plane | Team 기능과 관리형 운영·기업 기능 | 유료 Cloud 계약 |

무료 제한은 메뉴 숨김으로 구현하지 않습니다. 최소한 팀 조직 생성, 두 번째 활성 사람 Membership 추가, `MASSION_MODE=team`, 조직 범위 구독 계정 공유와 팀 배포 artifact 생성·시작에서 같은 entitlement 결정을 검사합니다.

유료 권리가 만료되거나 검증되지 않으면 신규 팀 변경과 실행은 fail closed합니다. 기존 데이터를 삭제하지 않으며 읽기, 백업, 내보내기와 개인 범위로의 안전한 downgrade는 허용합니다. 자체 호스팅은 Cloud 장애와 무관하게 검증할 수 있는 서명된 offline entitlement를 지원해야 합니다.

## 6. 라이선스 정합성

[Open Source Definition](https://opensource.org/osd)은 사람·집단과 업무 분야에 따른 사용 제한을 허용하지 않습니다. 따라서 개인용에만 무료인 Massion 제품 코드를 “오픈소스”라고 표시하지 않습니다.

법률 검토에서 다음을 확정해야 합니다.

- Massion 제품 코드: 개인 무료 source-available 라이선스 또는 비공개 proprietary + 개인용 EULA 중 하나
- Team Self-hosted: 상용 라이선스와 offline entitlement 조건
- Extension SDK·공개 protocol·client: 생태계 호환을 위한 별도 허용적 라이선스 여부
- `managed-service`: 비공개 상용 라이선스
- repository `LICENSE`, 각 npm package의 SPDX 또는 `SEE LICENSE IN ...`, binary·container·Extension artifact의 동일한 고지

라이선스가 없는 공개 저장소는 기본 저작권만 적용됩니다. 법률 결정을 마치기 전에는 새 remote를 공개하지 않고 package를 publish하지 않습니다.

## 7. History-free 이관과 추적성

### 7.1 고정 source와 내보내기

1. Phase 24·25 완료와 전체 gate 통과 뒤 clean source commit과 tree digest를 고정합니다.
2. 추적 중인 고정 commit에서만 export합니다. 미커밋 working tree를 복사하지 않습니다.
3. 허용 목록은 제품 코드, 현재 정본 설계, 운영 문서, test, migration, CI와 release script입니다.
4. 거부 목록은 `.git`, worktree metadata, build·cache·coverage·artifact, secret, 개인 경로, 대체된 역사 문서, 이전 제품명 전용 자료와 Cloud 전용 파일입니다.
5. 새 임시 디렉터리에서 각 저장소를 `git init`하고 새 root commit을 만듭니다.

### 7.2 계보 원장

과거 문제 추적 근거를 삭제하지 않고 공개 제품 tree 밖의 읽기 전용 private archive에 보존합니다.

- 고정한 기존 source commit·tree digest
- 파일별 기존 경로·SHA-256·새 경로 또는 제외 이유
- 요구사항별 기존 문서·test·commit과 새 import commit 대응
- export 도구 version·설정·실행 시각·서명
- 기존 전체 Git bundle과 최종 검증 영수증

새 저장소의 활성 요구사항 추적표는 새 commit만 참조합니다. 과거 commit 존재 여부를 새 Git object에서 찾지 않고 서명된 import manifest와 digest로 검증하도록 문서 검사기를 확장합니다. 공개 제품 저장소에는 이전 브랜드를 노출하지 않는 redacted provenance와 snapshot digest만 둡니다.

## 8. 공개 계약 추출

Cloud가 Core 내부 구현을 가져가지 않도록 다음 경계를 독립 package로 고정합니다.

- Application wire command·result·event·error와 검증 schema
- HTTP·Server-Sent Events(SSE) client
- Extension manifest·RPC 계약
- entitlement 확인 port와 edition capability 이름

공개 계약 package는 내부 store, coordinator, database repository와 SurrealDB record를 export하지 않습니다. Cloud CI는 허용된 package와 OCI digest 외의 Massion source import를 정적으로 거부합니다.

## 9. 데이터·릴리스 호환과 cutover

- 기존 최신 backup을 새 Core build에서 복구하고 migration checksum, 조직·업무·기록·Extension 정본 수를 비교합니다.
- 기존 설치의 config·data·backup 경로를 보존하거나 명시적 1회 migration을 제공합니다.
- Extension API version과 Registry protocol 호환 범위를 검증합니다.
- 새 source commit과 digest로 binary, container, SBOM, provenance와 release manifest를 모두 다시 생성합니다. 기존 artifact를 재사용하지 않습니다.
- 새 remote·tag·package scope·visibility는 소유자 확인 뒤 전환합니다.
- 새 clean clone의 설치·복구·업그레이드·rollback이 통과할 때까지 기존 저장소는 read-only archive로 유지합니다.

## 10. 보안 검증

- secret·credential·개인 경로·이전 remote URL 검사
- 기존 이름과 금지 경로의 0건 검사
- dependency license·저작권·기여 provenance와 SBOM 검사
- 새 저장소에서 기존 commit을 `git cat-file`로 찾을 수 없고 unreachable old object도 없는지 검사
- Core에서 Cloud package·billing endpoint import 0건, Cloud에서 Core 내부 package deep import 0건
- Personal Free 우회 경로와 위조·만료·rollback된 entitlement의 fail-closed 검사
- entitlement event·metric에는 사람·조직·license token 식별자를 label로 넣지 않음

## 11. 요구사항

- `REQ-REPO-001`: 새 Git 객체 저장소, 결정론적 허용 목록 import, 이전 제품 흔적 0건과 서명된 계보 원장을 검증합니다.
- `REQ-CLOUD-001`: Core와 Cloud의 단방향 versioned 계약·독립 build·release를 강제합니다.
- `REQ-EDITION-001`: 무료판은 사람 1명·개인 조직·loopback에 제한하면서 여러 Agent 협업을 보존합니다.
- `REQ-LICENSE-001`: repository, package, binary, container와 Extension의 실제 사용 권리가 일치합니다.
- `REQ-CUTOVER-001`: 기존 data·Extension·설정의 복구·upgrade·rollback과 새 provenance를 검증합니다.

## 12. 완료 조건

- Phase 24·25·26과 전체 lint·typecheck·test·build·문서·보안·release gate가 통과합니다.
- 두 새 저장소가 서로 다른 새 Git 객체 저장소와 각 하나의 새 root commit으로 시작합니다.
- 새 Core tree에서 금지된 이전 이름·경로·history object가 0건입니다.
- private import manifest가 기존 snapshot과 새 import를 파일·요구사항 단위로 연결하고 서명 검증됩니다.
- Personal Free의 한 사람 제한과 Team·Cloud 유료 경계가 domain·server·distribution에서 우회 불가능하게 검증됩니다.
- 여러 Core Agent와 Extension은 Personal Free에서 정상 동작합니다.
- Core↔Cloud 역의존·deep import가 0건이고 두 저장소가 독립 build·release됩니다.
- 라이선스·package metadata·artifact 고지가 법률 검토 결과와 일치합니다.
- clean clone 전체 검증, 기존 backup 복구, 새 release artifact·SBOM·provenance 생성과 rollback이 통과합니다.
- 실제 결과와 source/import/new commit digest를 Phase 27 회고에 남깁니다.

## 13. 비목표와 현재 gate

- Phase 24 구독 연결기와 Phase 25 평가실을 미완료 상태로 복사해 새 제품처럼 보이게 하지 않습니다.
- Phase 27에서 관리형 Cloud 전체를 새로 구현하지 않습니다. 별도 저장소와 계약·사업 경계를 먼저 만듭니다.
- 법률 자문 없이 커스텀 라이선스 문구를 작성하거나 공개 오픈소스라고 주장하지 않습니다.
- 이 문서 승인만으로 현재 작업 디렉터리에 새 repo나 외부 Git remote를 만들지 않습니다.

현재 Phase 24·25, 전체 lint·보안 gate와 라이선스 선택이 남아 있으므로 구현 시작 조건은 충족되지 않았습니다.
