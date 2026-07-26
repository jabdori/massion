# 페이즈 03 — 지식 그래프·검색·기억의 업무 연결

> **상태:** 코드·실제 Tauri 증분 검증 완료, 전체 K UAT 대기
> **시작 기준:** 워크스페이스 선택과 네이티브 파일 첨부의 코드 검증 완료
> **다음 게이트:** native picker를 포함한 전체 UAT-K01~K04와 릴리스 설치 게이트

## 목표

신뢰된 워크스페이스의 파일·코드 관계와 사용자가 저장한 개인 기억을 실제 Work의 입력과 실행 계보에 연결합니다. 기존 Scanner, Tree-sitter 색인, BM25 검색, 코드 그래프, EvidenceBrief, PromptMemory를 조립하며 새 watcher·queue·embedding 공급자·전역 그래프 탐색기는 만들지 않습니다.

## 단계

| 단계 | 현재 범위 | 상태 |
|---|---|---|
| 03-1 | Workspace와 Evidence Repository의 조직별 1:1 결속 | 코드 검증 완료 |
| 03-2 | 첨부 경로 경계 안 검색·1-hop 관계·EvidenceBrief | 코드 검증 완료 — 03-2a·03-2b1·03-2b2 완료 |
| 03-3 | Work·대화·Agent 실행의 같은 Brief 계보 | 구현 완료 — `138414f36` |
| 03-4 | 명시적 개인 기억의 version·Prompt·Runtime 계보 | 구현 및 실제 GLM 계보 확인 완료 — `74873ec2b` |
| 03-5 | 서버 생산 조립과 Desktop 출처·기억 UI | 구현 및 격리 Tauri 화면 확인 완료 — `8ef9a9816`; 전체 UAT-K01~K04 대기 |

## 현재 구현 경계

- Repository는 결속된 경우에만 `workspaceId`와 조직별 guard를 보관합니다. 기존 프로젝트 기반 또는 독립 Repository의 의미는 바꾸지 않습니다.
- 동일 조직에서 같은 Workspace를 다시 등록하면 기존 Repository를 재사용하고, 다른 Repository로 바꾸려는 요청은 거부해야 합니다.
- 다른 조직은 같은 Workspace 식별자를 알더라도 조회할 수 없어야 합니다.
- Work intake는 active·trusted Workspace만 통과시키고 기존 Scanner·Indexer·Search·CodeGraph·EvidenceBrief를 동기 조립합니다. 새 watcher·queue·embedding 공급자·전역 graph explorer는 만들지 않습니다.
- ready Brief는 Core Office 공유 출처와 ContextVersion metadata source에 고정하고, Representative·Strategy·Delivery는 실행 직전에 같은 snapshot을 자료화합니다.
- 명시적 개인 기억은 새 Work의 PromptVersion·RuntimeExecution에만 고정합니다. `앞으로 사용하지 않음`은 새 version을 만들며 과거 계보를 지우지 않습니다.
- LSP, embedding 공급자, SurrealDB native relation/DB traversal은 실제 UAT 실패 근거가 생길 때까지 v1 범위 밖입니다.

## 완료 근거 기록

각 단계가 끝날 때 구현 커밋, 표적 테스트, 타입 검사(typecheck), 문서 검사 결과를 이 문서에 추가합니다. 실제 앱에서 파일·출처·기억이 보이는지는 최종 Tauri UAT-K01~K04로만 완료 판정합니다.

### 03-1 — Workspace와 Evidence Repository 결속

- `d814df32a` — 기존 `0025-evidence-index`를 바꾸지 않고 additive `0033-evidence-workspace-binding` migration으로 선택적 Workspace ID와 조직별 guard를 추가했습니다.
- 결속된 Repository는 `organizationId:workspaceId` guard로 하나만 허용합니다. 같은 실제 root hash의 재등록은 기존 Repository를 반환하고, 다른 root hash로의 교체는 거부합니다.
- `findByWorkspace()`는 조직 ID와 guard를 함께 조회합니다. 다른 조직은 같은 Workspace ID를 사용해도 Repository를 찾지 못합니다.
- Workspace가 없는 기존 Repository는 여러 건을 계속 등록할 수 있으며, 기존 `projectId` 공개 뷰도 유지합니다.
- 동시 등록은 하나의 Repository와 각 명령의 event 두 건으로 수렴하는 회귀 검사를 추가했습니다.

| 검증 | 결과 |
|---|---|
| `pnpm --filter @massion/evidence test -- repository-store.test.ts` | 통과 — 18개 파일 중 17개 통과, 1개 의도된 skip, 60개 테스트 통과입니다. |
| `pnpm --filter @massion/evidence typecheck` | 통과 — Evidence 공개 계약과 저장소 구현이 TypeScript 검사에 통과했습니다. |
| `pnpm verify:docs`, `git diff --check` | 통과 — 페이즈 기록의 문서 구조와 변경 공백을 확인했습니다. |

이 단계는 Repository 결속만 소유합니다. 실제 워크스페이스의 canonical path 재검증, blocked·archived 상태 차단, Revision·Index 생성은 다음 Work intake 조립 단계에서 연결합니다.

### 03-2a — 첨부 범위 검색과 코드 관계 재해석

- `b28a866c7` — `relativePaths`가 있는 검색은 정확 일치, BM25, embedding 후보를 모두 첨부한 정규화 상대 경로 안으로 제한합니다. BM25 쿼리도 같은 범위에서 실행해 범위 밖 높은 점수가 범위 안 결과를 밀어내지 않습니다.
- 새 IndexVersion은 모든 파일을 stage·clone한 뒤 전체 symbol 집합으로 `imports`·`calls`·`implements` 관계를 다시 해석합니다. 후보가 없거나 둘 이상이면 stale target을 제거합니다.
- 멤버 호출은 마지막 이름이 같더라도 전역 symbol에 추측 연결하지 않습니다. 예를 들어 `client.target()`은 다른 파일의 `target()`으로 연결되지 않습니다.
- 기존 `contains` 관계, Workspace 결속, EvidenceBrief 저장소는 이 하위 단계에서 바꾸지 않았습니다.

| 검증 | 결과 |
|---|---|
| `pnpm --filter @massion/evidence test -- search.test.ts indexer.test.ts` | 통과 — 18개 파일 중 17개 통과, 1개 의도된 skip, 63개 테스트 통과입니다. |
| `pnpm --filter @massion/evidence typecheck` | 통과 — 검색 계약과 relation 재해석 API가 TypeScript 검사에 통과했습니다. |
| 대상 파일 `prettier --check`, `git diff --check` | 통과 — 코드 형식과 변경 공백을 확인했습니다. |

다음 03-2b는 빈 검색 결과도 Work 이력으로 남기는 no-match EvidenceBrief와 prompt materialization만 추가합니다. WorkspaceKnowledgeService·Work 조립·UI는 그 이후 단계의 책임으로 남습니다.

### 03-2b1 — no-match EvidenceBrief 영수증

- `d84b7d152` — 빈 검색 결과를 `no_match` EvidenceBrief로 저장할 수 있게 했습니다. 기존 수동 Brief는 계속 최소 한 개의 reference가 필요합니다.
- 자동 no-match는 `organizationId:workId` guard로 Work당 하나만 허용합니다. 같은 scope checksum의 재시도는 같은 Brief를 반환하고, 다른 scope checksum은 새 이력을 만들지 않고 거부합니다.
- `scopeChecksum`은 있을 때만 Brief checksum 입력에 들어가므로 이전 수동 Brief의 checksum 형식을 바꾸지 않습니다. checksum 또는 scope가 변조된 row는 조회에서 거부됩니다.
- Work별 목록은 조직 범위와 생성 시각 순서를 사용하며, 같은 Work의 수동 Brief와 자동 no-match 영수증은 공존할 수 있습니다.

| 검증 | 결과 |
|---|---|
| `pnpm --filter @massion/evidence test` | 통과 — 18개 파일 중 17개 통과, 1개 의도된 skip, 64개 테스트 통과입니다. |
| `pnpm --filter @massion/evidence typecheck` | 통과 — no-match 공개 계약과 기존 Brief 계약이 TypeScript 검사에 통과했습니다. |
| 대상 파일 `prettier --check`, `git diff --check` | 통과 — migration·저장소·회귀 테스트의 형식과 공백을 확인했습니다. |

다음 03-2b2는 현재 Scanner·Indexer·Search·Graph·Brief를 실제 Work 준비 흐름으로 조립하고, 검증된 chunk만 실행 직전에 prompt 자료로 materialize합니다.

### 03-2b2 — Work 코드 지식 조립과 prompt 자료화

- `9a8f13010` — 기존 Scanner·Revision·Indexer·Search·Graph·EvidenceBrief를 `WorkspaceKnowledgeService` 하나의 동기 흐름으로 조립했습니다. 새 queue, watcher, embedding 공급자, 전역 그래프 저장소는 추가하지 않았습니다.
- 같은 Work의 재시도는 파일을 다시 읽거나 현재 색인을 바꾸기 전에 자동 Brief의 scope·Brief checksum·RepositoryRevision·IndexVersion·snapshot checksum을 검증하고, 처음 Work가 고정한 근거를 반환합니다. 원 Workspace root가 사라진 뒤의 재시도도 이 저장된 snapshot으로 확인했습니다.
- 새 Work는 Workspace 결속 Repository의 실제 root hash를 다시 확인한 뒤 현재 Revision과 구성(configuration)을 기준으로 complete IndexVersion을 재사용하거나, 같은 구성에서는 incremental·다른 구성에서는 full 색인을 만듭니다. 검색 결과가 선택한 IndexVersion과 달라지면 혼합하지 않고 오류로 멈춥니다.
- 명시 첨부 경로는 정규화·정렬·중복 검증 뒤 scope checksum에 포함합니다. 첨부 범위에 usable chunk가 하나도 없으면 no-match로 조용히 진행하지 않고 차단합니다. 반대로 범위 없는 검색 결과 0건은 Work 이력에 `no_match` 영수증으로 남깁니다.
- 검색 결과와 1-hop `imports`·`calls`·`implements` 관계는 최대 12개 redacted chunk로 정규화해 자동 ready Brief에 저장합니다. 수동 Brief와 자동 Brief는 공존하며, 모든 생성 경로가 IndexVersion의 저장된 snapshot checksum과 실제 snapshot을 대조합니다.
- `EvidencePromptMaterializer`는 Work 소유 ready Brief의 chunk path·range·content hash·redaction·구성 checksum을 다시 확인하고, 원문을 자르지 않은 채 최대 24,000 estimated token을 반환합니다. 예산에 snippet 하나도 넣지 못하면 빈 근거로 실행하지 않고 오류를 냅니다.

| 검증 | 결과 |
|---|---|
| `pnpm --filter @massion/evidence test` | 통과 — 19개 파일 중 18개 통과, 1개 의도된 skip, 66개 테스트 통과입니다. root 삭제 재시도, 범위 밖 관계 제외, usable chunk 없는 첨부 차단, 범위 없는 no-match, snapshot 변조 거부, token 예산 차단을 포함합니다. |
| `pnpm --filter @massion/evidence typecheck` | 통과 — Evidence 공개 계약과 Work 지식·prompt 자료화 구현이 TypeScript 검사에 통과했습니다. |
| 대상 파일 `prettier --check`, `git diff --check` | 통과 — 형식과 변경 공백을 확인했습니다. |

이 하위 단계는 Evidence 패키지의 lower-level 준비 경계만 소유합니다. trusted·active Workspace 확인, blocked·archived Workspace 차단, Work·Room·SharedContext·ContextVersion·실행 prompt 연결은 다음 03-3 Core intake 단계에서 연결합니다.

### 03-3 — Work·대화·Agent 실행의 같은 Brief 계보

- `138414f36` — Intake가 trusted·active Workspace의 EvidenceBrief를 한 번 준비하고 Core Office 공유 출처와 ContextVersion metadata source에 같은 checksum으로 연결합니다.
- Representative·Strategy·Delivery와 software task는 요청 payload의 임의 Brief ID가 아니라 활성 ContextVersion의 검증된 출처만 자료화합니다. snapshot 손상·다른 Work 소유·hash 불일치는 `evidence-invalid`로 막습니다.
- `work.knowledge`는 Work가 실제로 사용한 path·symbol·line range와 fresh/stale 상태만 반환합니다. Repository·Index의 내부 ID나 전역 그래프 탐색기는 화면 계약에 넣지 않습니다.

### 03-4 — 명시적 개인 기억의 version·Prompt·Runtime 계보

- `74873ec2b` — 개인 기억의 최초 생성, CAS 갱신, `앞으로 사용하지 않음`을 사용자 범위 명령으로 연결했습니다. 새 Work만 해당 MemoryVersion을 PromptVersion·RuntimeExecution에 고정하고 과거 계보는 바꾸지 않습니다.
- 표적 생산 조립 검증으로 `pnpm --filter @massion/growth build && pnpm --filter @massion/server exec vitest run src/product.test.ts -t 'clean install에서 Z.AI Core 실행의 RuntimeExecution에 개인 기억 계보를 고정한다'`를 실행했습니다. 1개 통과, 15개는 이름 필터로 skip되었습니다.

### 03-5 — 서버 생산 조립과 Desktop 출처·기억 UI

- `8ef9a9816` — DesktopService가 typed `work.knowledge`를 조회하고 Work 세부 정보에 `지식` 탭을 추가했습니다. ready/no-match/blocked/not-applicable 상태는 사람이 읽는 문구로 분리했고, ready reference만 Core Office 공유 출처로 이동합니다.
- 실제 후보 `e3b5fe883` 번들에서 workspace의 `README.md`를 첨부한 Work를 실행하고 `work.knowledge=ready`, README reference 2개, 완료 Work·재시작 보존을 확인했습니다. 전체 K01~K04와 native picker는 아직 대기 중입니다. [최신 증거](../../../evidence/phase-30/desktop-live-tauri-uat-2026-07-26-e3b5fe883.md)

| 검증 | 결과 |
|---|---|
| `pnpm --filter @massion/desktop exec vitest run src/desktop-service.test.ts -t 'Work의 사용한 지식은 typed work.knowledge 조회로 반환한다'` | 통과 — 1개 통과, 17개 이름 필터 skip |
| `pnpm --filter @massion/desktop exec vitest run src/app.integration.test.tsx -t '워크스페이스 없는 Work의 지식 빈 상태는 산출물 안내를 재사용하지 않는다'` | 통과 — 1개 통과, 31개 이름 필터 skip |
| `pnpm --filter @massion/desktop typecheck` | 통과 |
| 격리 릴리스 번들 생성 및 실제 화면 확인 | 통과 — 최종 공개 후보·서명·공증·전체 UAT를 뜻하지 않음 |

세부 관측과 남은 동일 후보 SHA 게이트는 [2026-07-26 증분 UAT 기록](../../../evidence/phase-30/knowledge-memory-uat-2026-07-26.md)에 남깁니다.
