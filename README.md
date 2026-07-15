# Massion AgentOS

Massion AgentOS 1.0은 개인이나 팀이 여러 AI 에이전트(agent)를 조직처럼 구성하고, 일을 맡기고, 서로 협업하게 하며, 결과와 근거를 추적할 수 있게 하는 설치형 에이전트 운영체제(Agent Operating System)입니다.

기본 제품에는 조직과 역할을 만드는 Core Office, 작업·대화·할당 파이프라인, 선택형 승인 정책, 다중 모델 공급자 라우팅과 장애 대체(fallback), 근거·품질 보증·기록·성장 파이프라인, 확장 프로그램(Extension) SDK·Registry, CLI·TUI·Web Console, 로컬 및 자체 호스팅 배포가 포함됩니다.

## 사용자 설치

- 개인 macOS·Linux: [개인용 설치·운영 안내](docs/operations/local-install.md)
- Docker Compose·Kubernetes: [자체 호스팅 설치 Runbook](docs/operations/self-hosting-install.md)
- 백업·복구: [백업·복구 Runbook](docs/operations/backup-restore.md)
- 업그레이드·되돌리기: [업그레이드·Rollback Runbook](docs/operations/upgrade-rollback.md)

macOS·Linux에서는 공개 릴리스 설치 스크립트를 통해 사용자 권한으로 설치할 수 있습니다. 스크립트는 GitHub Releases의 고정 버전 매니페스트(manifest)와 압축 파일을 내려받고 SHA-256 해시(hash)를 확인한 뒤 설치합니다.

현재 `v1.0.0` GitHub Release에 검증된 개인용 설치 자산이 게시되어 있습니다. 아래 명령은 고정된 릴리스 매니페스트와 SHA-256 해시를 확인한 뒤 설치합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jabdori/massion/main/install.sh | bash
```

스크립트를 먼저 검토하려면 파일로 내려받아 확인한 뒤 실행합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jabdori/massion/main/install.sh -o /tmp/massion-install.sh
less /tmp/massion-install.sh
sh /tmp/massion-install.sh
```

설치 버전과 설치 위치는 환경 변수(environment variable)로 고정할 수 있습니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jabdori/massion/main/install.sh \
  | MASSION_VERSION=1.0.0 MASSION_PREFIX="$HOME/.local" bash
```

설치 스크립트에는 `curl`, `tar`, Node.js 24 이상, Bun 1.3 이상, `sha256sum` 또는 macOS의 `shasum`이 필요합니다. 수동 압축 해제와 설치가 필요한 경우에는 [개인용 설치·운영 안내](docs/operations/local-install.md)를 따릅니다.

개인 설치 후 가장 짧은 시작 흐름은 다음과 같습니다.

```sh
massion local start
massion init http://127.0.0.1:7331 owner@example.com "내 이름"
massion
# 또는 브라우저를 열어 Web Console을 사용합니다.
massion --web
```

초기화가 끝난 뒤 인자 없이 `massion`을 실행하면 터미널 사용자 인터페이스(TUI)가 열립니다. 아직 초기화하지 않았다면 먼저 실행할 `massion init` 명령을 안내합니다. `massion --web`은 인증된 로컬 서버에 5분 유효한 일회성 로그인 티켓을 만들고 기본 브라우저를 연 뒤, 화면에 한 번만 사용할 코드를 출력합니다.

## TUI와 Web Console

Massion은 같은 조직·업무 데이터를 두 가지 화면으로 제공합니다. 둘 중 하나를 선택해도 같은 로컬 서버와 profile을 사용하므로, TUI에서 만든 업무를 Web Console에서 이어서 확인할 수 있습니다.

### TUI: 터미널에서 운영하기

터미널 사용자 인터페이스(TUI)는 키보드로 빠르게 상태를 확인하고 업무를 운영하는 화면입니다. 다음 영역을 한 화면 안에서 전환할 수 있습니다.

- 개요: 진행 중인 업무, 실행 중 에이전트, 대기 승인, 토큰·비용
- 협업 맵: 조직의 에이전트, 역할, 현재 업무와 모델 경로
- 업무·대화: 업무 상태, 작업 배정, 실행, 협업방 메시지
- 승인: 명령·파일 변경 등 실행 전 승인 요청
- 운영·구독: 라우팅, Provider 연결, 계정·할당량·정책, 모델 평가실

초기화한 뒤 다음 명령을 실행하면 TUI가 바로 열립니다.

```sh
massion
```

화면 하단의 도움말(`?`)에서 전체 키를 볼 수 있습니다. 자주 쓰는 키는 다음과 같습니다.

```text
1–7       화면 전환
j / k     목록 이동
r         새로고침
/         현재 화면 검색
?         키보드 도움말
Ctrl+C    종료
```

### Web Console: 브라우저에서 운영하기

Web Console은 브라우저에서 조직 개요와 업무·승인·감사·기억·확장·접근·구독·모델 평가실을 확인하는 화면입니다. 여러 정보를 넓은 화면에서 비교하거나 승인 요청을 검토할 때 적합합니다.

먼저 로컬 서버를 실행하고 Web Console을 엽니다.

```sh
massion local start
massion --web
```

`massion --web`은 저장된 profile을 재사용해 5분 동안만 유효한 일회성 로그인 티켓을 발급합니다. 기본 브라우저가 열리고, 터미널에는 로그인 URL·코드·만료 시각이 표시됩니다. 브라우저가 자동으로 열리지 않으면 출력된 URL을 직접 열고 코드를 입력하면 됩니다. 로그인 코드는 URL에 포함하지 않습니다.

아직 profile이 없으면 Web Console을 열지 않고 다음 초기화 명령을 안내합니다.

```sh
massion init http://127.0.0.1:7331 owner@example.com "내 이름"
```

## 개발과 검증

검증 기준 도구는 Node.js 24.8.0, Bun 1.3.14, pnpm 11.13.0입니다. `package.json`은 Node.js 24 이상을 허용합니다.

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
