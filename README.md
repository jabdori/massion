# Massion AgentOS

> **개발 상태:** Phase 30 진행 중입니다. Guided Workspace 재설계로 Web과 TUI 모두 친화적 사용자 경험을 제공합니다. Z.AI GLM Coding Plan 단일 계정으로 에이전트 조직의 완료 흐름을 검증했습니다. 복수 계정 quota·fallback과 접근성 parity는 진행 중입니다.

Massion AgentOS는 개인이나 팀이 여러 AI 에이전트(agent)를 조직처럼 구성하고, 일을 맡기고, 서로 협업하게 하며, 결과와 근거를 추적할 수 있게 하는 설치형 에이전트 운영체제(Agent Operating System)를 목표로 합니다.

제품 범위에는 조직과 역할을 관리하는 핵심 코어, 작업·대화·할당 파이프라인, 선택형 승인 정책, 다중 모델 공급자 라우팅과 장애 대체(fallback), 근거·품질 보증·기록·성장 파이프라인, 확장 프로그램(Extension) SDK·Registry, CLI·TUI·Web Console, 로컬 및 자체 호스팅 배포가 포함됩니다.

## 사용자 설치

- 개인 macOS·Linux: [개인용 설치·운영 안내](docs/operations/local-install.md)
- Docker Compose·Kubernetes: [자체 호스팅 설치 Runbook](docs/operations/self-hosting-install.md)
- 백업·복구: [백업·복구 Runbook](docs/operations/backup-restore.md)
- 업그레이드·되돌리기: [업그레이드·Rollback Runbook](docs/operations/upgrade-rollback.md)

macOS·Linux에서는 사용자 권한으로 설치합니다. 현재 설치 artifact 버전은 `v1.0.0`입니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jabdori/massion/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

스크립트를 검토하려면 내려받은 뒤 실행합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jabdori/massion/main/install.sh -o /tmp/massion-install.sh
less /tmp/massion-install.sh
sh /tmp/massion-install.sh
```

버전과 설치 위치를 지정할 수도 있습니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jabdori/massion/main/install.sh \
  | MASSION_VERSION=1.0.0 MASSION_PREFIX="$HOME/.local" bash
```

설치에는 `curl`, `tar`, Node.js 24 이상, Bun 1.3 이상, `sha256sum` 또는 `shasum`이 필요합니다. 자세한 절차는 [개인용 설치·운영 안내](docs/operations/local-install.md)를 참고하세요.

개인 설치 후 가장 짧은 시작 흐름은 다음과 같습니다.

```sh
massion
# 또는 브라우저를 열어 Web Console을 사용합니다.
massion --web
```

설치 상태와 사용법은 다음처럼 확인합니다.

```sh
massion --help
massion --version
```

설치된 Massion의 릴리스를 확인하거나 올릴 때는 두 명령을 구분합니다.

```sh
massion update          # 최신 릴리스 확인
massion upgrade         # 최신 릴리스 설치(호환 시)
```

`upgrade`는 릴리스 매니페스트(manifest)의 플랫폼·Node.js·Bun·주 버전 호환성 검사를 통과한 경우에만 아카이브를 SHA-256으로 검증하고 교체합니다.

## 5분 첫 사용 예시

처음에는 에이전트 조직이나 라우팅 설정을 모두 이해할 필요가 없습니다. 아래 순서로 개인용 Massion을 실행하고 첫 업무를 확인할 수 있습니다.

### 1. 온보딩 시작

설정이 없는 터미널에서 `massion`만 실행합니다. 로컬 서버가 자동으로 준비되고 다음 두 항목을 묻습니다.

```text
$ massion
소유자 이메일: owner@example.com
표시 이름: 내 이름
```

TUI가 열리면 화면 상단 연결 상태가 `live`인지 확인합니다. `live`는 Massion 애플리케이션(application)과 정상적으로 연결됐다는 뜻입니다. 처음부터 `massion init`이나 `massion local start`를 따로 입력할 필요가 없습니다.

### 2. 화면에서 상태 확인

TUI에서는 Tab 키로 화면을 전환합니다. 기본 화면은 작업 목록과 진행 상황이 함께 보입니다.

```text
Tab       화면 전환(작업 → 확인 → 대화 → 개요 → 협업 → 운영 → 구독)
j / k     목록 이동
n         새 작업 시작
m         메시지 보내기
d         자세히 보기(기술 정보)
/         현재 화면 검색
r         새로고침
?         키보드 도움말
Ctrl+C    종료
```

처음에는 작업 화면과 확인 화면만 봐도 충분합니다. `Ctrl+C`로 TUI를 닫아도 로컬 서버와 데이터는 유지됩니다.

### 3. Provider 온보딩(선택)

실제 AI 모델로 업무를 실행하려면 Provider 온보딩을 한 번 진행합니다.

```sh
massion auth login
```

화면에서 Provider를 선택하면 해당 인증 화면으로 이동합니다. 이미 연결된 profile이 있으면 다시 로그인하지 않고 재사용합니다. 특정 Provider를 바로 지정할 때는 `massion auth login openai-codex`처럼 실행할 수 있습니다. 모델을 연결하지 않아도 TUI·조직·업무 기록·백업 기능은 확인할 수 있습니다. API key나 endpoint를 직접 등록하는 고급 작업은 `provider` 명령 그룹을 사용합니다.

### 4. 첫 업무 만들기

TUI에서는 `n`을 누르고 업무 내용을 입력합니다. Web Console에서는 `새 업무 요청`에 내용을 쓰고 `업무 시작`을 누릅니다. 모델을 아직 연결하지 않아도 업무·협업방·기록은 만들어지며, 모델 실행만 차단됩니다.

업무의 대표적인 종료 상태는 다음과 같습니다.

```text
completed          업무가 완료됨
awaiting-approval  사람의 승인이 필요한 단계에서 대기 중
blocked            모델·권한·정책 문제로 진행이 멈춤
failed             실행 오류로 실패함
cancelled          사용자가 취소함
```

완료된 업무와 작업은 TUI의 `3` 업무 화면이나 Web Console에서 다시 볼 수 있습니다. 자동화할 때만 `massion run`을 사용합니다.

```sh
massion status --json
```

### 5. 브라우저에서 이어서 보기

같은 개인 조직을 브라우저에서 보려면 다른 터미널에서 Web Console을 엽니다. TUI와 Web은 동시에 사용할 수 있습니다.

```sh
massion --web
```

터미널에 표시되는 일회성 로그인 코드와 주소를 사용하면 TUI에서 확인한 업무·승인·구독 상태를 그대로 이어서 볼 수 있습니다.

### 6. 문제가 생겼을 때

다음 세 명령으로 설치·서버·애플리케이션 상태를 분리해서 확인합니다.

```sh
massion --version
massion local status --json
massion status --json
```

연결 상태가 `live`가 아니거나 접근 token이 만료됐다는 메시지가 나오면 `massion`을 다시 실행하세요. 필요한 경우 온보딩이 재연결 절차로 다시 열립니다.

## TUI와 Web Console

Massion은 같은 조직·업무 데이터를 두 가지 화면으로 제공합니다. 둘 중 하나를 선택해도 같은 로컬 서버와 profile을 사용하므로, TUI에서 만든 업무를 Web Console에서 이어서 확인할 수 있습니다.

### TUI: 터미널에서 빠르게 작업하기

터미널 사용자 인터페이스(TUI)는 키보드로 빠르게 작업을 확인하고 진행하는 화면입니다. 기본 화면은 작업 목록과 진행 상황이 한눈에 보이는 2패널 구조입니다.

- 작업: 진행 중인 작업과 완료된 결과
- 확인: 실행 전 사용자 확인이 필요한 요청
- 대화: 에이전트 협업 메시지
- 개요: 전체 진행 상황 요약
- 협업: 조직의 에이전트와 역할
- 운영: 라우팅, Provider 연결, 계정·할당량·정책
- 구독: 모델 평가실

`Tab`으로 화면을 전환하고 `d`로 기술 정보를 펼칩니다. 화면 하단의 도움말(`?`)에서 전체 키를 볼 수 있습니다.

### Web Console: 브라우저에서 작업하기

Web Console은 브라우저에서 작업을 요청하고 진행 상황을 확인하는 화면입니다. "안녕하세요. 무엇을 도와드릴까요?"로 시작하며, 친화적 상태 표시와 4단계 진행 바로 작업 과정을 한눈에 파악할 수 있습니다. 승인이 필요한 항목은 위험도와 함께 표시됩니다.

```sh
massion --web
```

`massion --web`은 저장된 profile로 5분 유효한 로그인 티켓을 발급하고 브라우저를 엽니다. URL·코드는 터미널에 출력됩니다.

대화형 터미널에서 profile이 없으면 `massion --web`도 같은 온보딩을 안내합니다. 자동화에서만 명시적 초기화를 사용합니다.

### 설치 후 아무것도 보이지 않을 때

화면이 보이지 않으면 다음을 확인하세요.

```sh
command -v massion
massion version
stty size
```

실행 파일이 없으면 설치 경로를 추가합니다.

```sh
export PATH="$HOME/.local/bin:$PATH"
```

TUI는 대화형 TTY와 최소 `80×24` 터미널이 필요합니다.

## 개발과 검증

개발·검증 기준 도구는 Node.js 24.8.0, Bun 1.3.14, pnpm 11.13.0입니다. pnpm은 저장소를 개발하고 테스트할 때만 필요하며 공개 설치 후에는 필요하지 않습니다. 현재 개인용 릴리스는 CLI·서버에 Node.js 24 이상, OpenTUI 기반 TUI에 Bun 1.3 이상이 필요합니다.

```sh
corepack enable
corepack prepare pnpm@11.13.0 --activate
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:security
pnpm verify:hardening
```

제품의 현재 구조는 [전체 아키텍처](docs/architecture/README.md), 진행 중인 요구사항과 구현 근거는 [요구사항 추적표](docs/generated/requirements-traceability.tsv), 설치·복구 절차는 [운영 문서](docs/operations/)에서 확인할 수 있습니다. 새 저장소에는 현재 제품 코드와 Phase 24 이후의 유지보수·전환 문서만 남기며, 이전 Phase 문서는 비공개 기록 저장소에서 보존합니다.

## 지원 경계

- 개인 설치 공식 대상은 macOS·Linux입니다.
- 모델 자격 증명이 없으면 제한 모드로 실행되며 모델 호출 작업만 차단됩니다.
- Kubernetes 기본 배포는 단일 복제본과 파일 기반 저장소입니다. 별도 공유 저장소 없이 고가용성(HA)을 주장하지 않습니다.
- 공개 배포 라이선스는 법적 검토와 소유자의 명시적 승인이 필요합니다. 현재 저장소의 파일 존재만으로 별도 사용 허가를 의미하지 않습니다.
- 공개 명령어는 `massion` 하나로 통일합니다. `mass`와 `massion-tui`는 호환 별칭(alias)으로 제공하지 않습니다.
