# Massion AgentOS

[English](README.md) | [한국어](README.ko.md)

> [!WARNING]
> **Massion은 활발히 개발 중인 사전 릴리스(pre-release) 프로젝트입니다.**
> 공개 설치 가능한 안정 버전은 없으며 API, 데이터 구조와 사용자 경험이 변경될 수 있습니다. 저장소의 빌드와 자동 검사는 공개 릴리스 또는 운영 환경 사용 가능성을 의미하지 않습니다.

Massion은 개인이 자기 Mac에서 여러 AI 에이전트를 조직처럼 운영하고, 하나의 사명(Mission)을 영속 업무(Work)로 만들어 요청·실행·승인·독립 검증·기록·자가개선을 같은 계보로 관리하는 로컬 AgentOS입니다.

## 제품의 운영 순환

### 업무(Work) — 실행에 책임을 연결합니다

![협업방을 중심으로 하나의 Work를 운영하는 Massion 화면](docs/assets/readme/agentos-work.png)

하나의 영속 협업방에서 요청, 계획, 담당 Agent, 승인, 산출물, 예산과 현재 실행 상태를 함께 추적합니다.

### 조직(Organization) — 책임 구조를 보이게 합니다

![버전된 조직과 업무별 임시 팀을 보여주는 Massion 조직 화면](docs/assets/readme/agentos-organization.png)

핵심 책임, 전문 팀, 보고 관계와 특정 Work를 위해 잠시 편성된 조직까지 Prompt 속에서 사라지지 않고 확인할 수 있습니다.

### 지식(Knowledge) — 주장과 출처를 연결합니다

![Work와 파일·문서의 관계를 탐색하는 Knowledge 화면](docs/assets/readme/agentos-knowledge.png)

Workspace의 출처와 관계를 Work, 문서, 파일, 심볼, 산출물과 담당자 관점에서 탐색합니다.

### 자가개선(Growth) — 검증된 경험만 다음 실행을 바꿉니다

![근거와 반대 증거, 채택과 기억 제어를 보여주는 Massion 개선 화면](docs/assets/readme/agentos-growth.png)

개선 제안은 원인 Work, 찬성·반대 신호, 평가, 버전된 변경, 채택 정책과 되돌리기 경로를 보존합니다.

> 화면은 기준 커밋의 시연 데이터(fixture)를 렌더링한 제품 방향 예시입니다. 실제 Provider 실행, 사용자 데이터, Records fixture 또는 공개 릴리스 완료를 증명하지 않습니다.

## 우리가 만들고 있는 것

Massion의 중심은 채팅 세션이 아니라 Work입니다. 사용자가 일을 맡기면 조직이 다음 책임을 나누고, 각 단계의 상태와 근거를 영속적으로 남깁니다.

```text
사용자 요청
→ 맥락과 전략
→ 지식과 근거
→ 실행과 협업
→ 사람의 승인
→ 독립 검증(Assurance)
→ 기록(Records)
→ 근거 기반 자가개선(Growth)
```

첫 공개 목표는 개인용 macOS arm64 데스크톱 앱입니다. 홈, 업무, 지식, 조직, 개선, 확장, 프로바이더, 예산과 설정은 서로 다른 질문에 답하지만 같은 Application 상태와 Work 계보를 사용합니다.

## 핵심 원칙

- **대화가 아니라 Work와 불변 사건이 정본입니다.** 모델 transcript만으로 조직 상태나 완료를 복원하지 않습니다.
- **완료는 모델의 선언이 아닙니다.** 실행 책임과 분리된 독립 검증과 Records를 통과해야 합니다.
- **Provider가 제품 상태를 소유하지 않습니다.** 모델 호출이 막혀도 조회·승인·취소·진단은 제한 모드로 유지합니다.
- **자가개선은 보수적인 채택입니다.** 근거, 반대 증거, 효과 평가와 되돌리기 없이 모델이 즉시 자신을 바꾸지 않습니다.
- **권한은 사람이 선택하고 회수합니다.** 일반 실행은 정책과 Workspace 경계를 지키고, 전체 권한은 명시적인 사용자 선택으로만 활성화합니다.

## 공개 릴리스 경계

- 공개 설치 가능한 릴리스는 없습니다.
- 과거 GitHub Release `v1.0.0`은 철회됐습니다. 원격 태그는 당시 소스의 감사 기준선일 뿐 설치본이나 재사용 가능한 릴리스 태그가 아닙니다.
- 자동 검사, fixture, 임시 패키징과 과거 UAT는 각각 결속된 커밋의 증거이며 최신 공개 릴리스를 대신하지 않습니다.
- 서명·공증·Gatekeeper·깨끗한 Mac 설치·업데이트·제거와 실제 접근성 검증은 공개 릴리스 후보에서 다시 수행해야 합니다.

검증 결과는 날짜와 후보 SHA에 결속된 [`docs/evidence/`](docs/evidence/)에서만 확인합니다.

## 개발 실행

저장소 기준 도구는 Node.js 24 이상, Bun 1.3 이상, pnpm 11.13.0, Rust와 Tauri 2입니다.

```sh
corepack enable
corepack prepare pnpm@11.13.0 --activate
pnpm install --frozen-lockfile
pnpm --filter @massion/desktop tauri:dev
```

변경 영역을 먼저 확인한 뒤 묶음 경계에서 넓은 검증을 실행합니다.

```sh
pnpm --filter @massion/desktop test
pnpm --filter @massion/desktop typecheck
pnpm verify
```

`pnpm verify:release`는 레거시 CLI·TUI·Web 배포 묶음도 검사합니다. 개인용 데스크톱 공개 릴리스의 단독 완료 근거가 아닙니다.

## 문서

- [문서 지도와 용어](docs/README.ko.md)
- [제품 헌법](docs/product/constitution.ko.md)
- [AgentOS 아키텍처](docs/architecture/README.ko.md)
- [데스크톱 시각 언어](apps/desktop/DESIGN.ko.md)
- [운영 안내](docs/operations/)
- [검증 증거](docs/evidence/)

`docs/superpowers/specs/`, `docs/superpowers/plans/`와 `docs/phases/`는 날짜에 결속된 설계·실행 기록입니다. 오래된 문서의 문장이 최신 상태를 증명하지 않습니다.

## 저장소 범위

- `apps/desktop`이 첫 개인용 메인 릴리스 표면입니다.
- `apps/web`과 `apps/tui`는 제거를 준비하는 레거시 표면입니다.
- 기존 CLI, Compose와 Kubernetes 경로는 운영·역사적 검증 코드로 남아 있지만 개인용 1.0의 설치 경로가 아닙니다.

## License

Massion은 [MIT License](LICENSE)로 배포됩니다.
