# Massion AgentOS

Massion AgentOS 1.0은 개인이나 팀이 여러 AI 에이전트(agent)를 조직처럼 구성하고, 일을 맡기고, 서로 협업하게 하며, 결과와 근거를 추적할 수 있게 하는 설치형 에이전트 운영체제(Agent Operating System)입니다.

기본 제품에는 조직과 역할을 만드는 Core Office, 작업·대화·할당 파이프라인, 선택형 승인 정책, 다중 모델 공급자 라우팅과 장애 대체(fallback), 근거·품질 보증·기록·성장 파이프라인, 확장 프로그램(Extension) SDK·Registry, CLI·TUI·Web Console, 로컬 및 자체 호스팅 배포가 포함됩니다.

## 사용자 설치

- 개인 macOS·Linux: [개인용 설치·운영 안내](docs/operations/local-install.md)
- Docker Compose·Kubernetes: [자체 호스팅 설치 Runbook](docs/operations/self-hosting-install.md)
- 백업·복구: [백업·복구 Runbook](docs/operations/backup-restore.md)
- 업그레이드·되돌리기: [업그레이드·Rollback Runbook](docs/operations/upgrade-rollback.md)

개인 설치 후 가장 짧은 시작 흐름은 다음과 같습니다.

```sh
mass local start
mass init http://127.0.0.1:7331 owner@example.com "내 이름"
mass status
mass run "첫 번째 작업" --detach
```

## 개발과 검증

검증 기준 도구는 Node.js 24.18.0, Bun 1.3.14, pnpm 10.30.3입니다.

```sh
corepack enable
corepack prepare pnpm@10.30.3 --activate
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:security
pnpm verify:hardening
```

제품 설계와 요구사항 계보는 [완제품 설계](docs/product/2026-07-10-complete-product-design.md), [전체 프로그램 계획](docs/superpowers/plans/2026-07-10-massion-agentos-1.0-program.md), [요구사항 추적표](docs/generated/requirements-traceability.tsv)에서 확인할 수 있습니다.

## 지원 경계

- 개인 설치 공식 대상은 macOS·Linux입니다.
- 모델 자격 증명이 없으면 제한 모드로 실행되며 모델 호출 작업만 차단됩니다.
- Kubernetes 기본 배포는 단일 복제본과 파일 기반 저장소입니다. 별도 공유 저장소 없이 고가용성(HA)을 주장하지 않습니다.
- 공개 배포 라이선스는 법적 검토와 소유자의 명시적 승인이 필요합니다. 현재 저장소의 파일 존재만으로 별도 사용 허가를 의미하지 않습니다.
