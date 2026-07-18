# Phase 30 Slice 1B — 개인용 로컬 런타임

> **상태:** 설계 확정 대기
> **목적:** Massion 개인용 제품을 SurrealDB 3.2.1 기반의 독립적인 로컬 AgentOS로 완성합니다.

## 제품 결정

- 이번 release는 clean reset입니다. 이전 설치를 이어받거나 migration하지 않습니다.
- 개인용 runtime은 Massion이 관리하는 native SurrealDB 3.2.1 sidecar를 사용합니다.
- `massion`은 TUI, `massion --web`은 Web Console을 엽니다.
- 설정이 없으면 두 화면 모두 onboarding을 제공합니다.
- 공개 실행 명령은 `massion`, `massion-connector`입니다.
- 새 설치에는 기존 local data를 보존하는 호환 경로가 없습니다. interactive reset은 확인을 받고, 자동 실행은 사용자의 approval policy가 허용할 때만 실행합니다.
- migration CLI는 만들지 않습니다. 미래 major runtime 변경이 실제 data conversion을 요구할 때만 별도 Phase에서 설계합니다.

## 사용자 경험

### 시작

```text
massion
massion --web
massion init
massion auth login
```

- `massion`은 TUI onboarding 또는 TUI를 엽니다.
- `massion --web`은 Web onboarding 또는 Web Console을 엽니다.
- `massion init`은 자동화와 명시적 초기화에 사용합니다.
- `massion auth login`은 provider와 account를 연결합니다.
- local access token은 정상 상황에서 자동 갱신합니다. local key나 설정이 손상된 경우에만 recovery 화면을 제공합니다.

TUI와 Web은 작업, 채팅, agent 관리, provider 관리, approval, backup/restore를 같은 제품 기능으로 제공합니다.

### backup·restore

```text
massion backup create <absolute-path>
massion backup restore <absolute-path> --yes
```

- TUI와 Web에도 같은 기능을 제공합니다.
- backup은 현재 personal installation에만 적용합니다.
- restore는 후보 database에서 검증한 뒤 적용합니다.
- 실패한 restore는 현재 database를 바꾸지 않습니다.
- restore 뒤에는 local profile과 TUI·Web 세션을 자동으로 다시 연결합니다.

## 제품 경계

### local runtime

- native SurrealDB 3.2.1 binary를 검증해 sidecar로 실행합니다.
- application은 authenticated loopback connection만 사용합니다.
- current SurrealDB major 안의 compatible minor/patch update는 현재 data를 유지합니다.
- runtime major가 달라지면 `massion upgrade`는 `requires-major-migration`으로 중단합니다.
- production storage는 native binding에 의존하지 않습니다.

### local supervisor

- CLI, TUI, Web, backup/restore는 하나의 local supervisor를 통해 runtime을 제어합니다.
- supervisor는 local lifecycle, onboarding, profile renewal, backup/restore를 관리합니다.
- 일반 제품 작업은 restore 중 멈추고, 후보 검증은 provider·connector·scheduler를 시작하지 않습니다.
- access token, provider secret, database credential은 화면·URL·log에 출력하지 않습니다.

### release

- `massion update`는 update 확인입니다.
- `massion upgrade`는 compatible application release 설치입니다.
- release manifest는 required runtime version을 포함합니다.
- installer는 `massion`, `massion-connector`만 설치합니다.
- 현재 사용자 문서, installer, release archive, UAT는 이 사용자 흐름만 설명하고 검증합니다.

### identity

- 새 personal installation은 owner와 personal organization으로 시작합니다.
- 협업 사용자는 기존 organization의 member로 추가합니다.
- Cloud billing, managed identity, SSO/SCIM은 이 Slice의 범위가 아닙니다.

## 구현 순서

1. clean reset과 native runtime 경계를 구현합니다.
2. onboarding, local profile renewal, supervisor entrypoint를 구현합니다.
3. TUI·Web·CLI의 공통 기능을 연결합니다.
4. personal backup/restore를 구현합니다.
5. release update/upgrade와 설치 경험을 구현합니다.
6. clean clone, tmux, TUI, Web, backup/restore, update/upgrade를 검증하고 Phase evidence를 남깁니다.

각 단계는 failing test를 먼저 만들고, 작은 code commit과 실제 검증 결과를 남깁니다.

## 완료 기준

1. 새 설치가 native SurrealDB 3.2.1 runtime과 onboarding을 실제로 완료합니다.
2. `massion`, `massion --web`, `init`, `auth login`이 실제 사용자 흐름으로 동작합니다.
3. TUI와 Web이 핵심 기능을 같은 API 계약으로 수행합니다.
4. personal backup create/restore가 성공하고 invalid input은 현재 data를 바꾸지 않습니다.
5. local token renewal과 restore 뒤 재연결이 정상 동작합니다.
6. compatible 3.x update는 current data를 유지하고 major runtime change는 중단합니다.
7. format·lint·typecheck·test·build·security 검사와 clean-clone/tmux scenario가 통과합니다.
