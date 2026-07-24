# 페이즈 03 — 지식 그래프·검색·기억의 업무 연결

> **상태:** 진행 중
> **시작 기준:** 워크스페이스 선택과 네이티브 파일 첨부의 코드 검증 완료
> **다음 게이트:** Work·대화·실행·데스크톱에서 같은 출처와 기억 계보를 조회

## 목표

신뢰된 워크스페이스의 파일·코드 관계와 사용자가 저장한 개인 기억을 실제 Work의 입력과 실행 계보에 연결합니다. 기존 Scanner, Tree-sitter 색인, BM25 검색, 코드 그래프, EvidenceBrief, PromptMemory를 조립하며 새 watcher·queue·embedding 공급자·전역 그래프 탐색기는 만들지 않습니다.

## 단계

| 단계 | 현재 범위 | 상태 |
|---|---|---|
| 03-1 | Workspace와 Evidence Repository의 조직별 1:1 결속 | 코드 검증 완료 |
| 03-2 | 첨부 경로 경계 안 검색·1-hop 관계·EvidenceBrief | 대기 |
| 03-3 | Work·대화·Agent 실행의 같은 Brief 계보 | 대기 |
| 03-4 | 명시적 개인 기억의 version·Prompt·Runtime 계보 | 대기 |
| 03-5 | 서버 생산 조립과 Desktop 출처·기억 UI | 대기 |

## 현재 구현 경계

- Repository는 결속된 경우에만 `workspaceId`와 조직별 guard를 보관합니다. 기존 프로젝트 기반 또는 독립 Repository의 의미는 바꾸지 않습니다.
- 동일 조직에서 같은 Workspace를 다시 등록하면 기존 Repository를 재사용하고, 다른 Repository로 바꾸려는 요청은 거부해야 합니다.
- 다른 조직은 같은 Workspace 식별자를 알더라도 조회할 수 없어야 합니다.
- 실제 디렉터리 canonical path 재검증, blocked·archived Workspace 차단, 색인 실행 연결은 다음 Work intake 조립 단계에서 함께 검증합니다. 이 첫 단계에서 별도 adapter나 background process를 만들지 않습니다.

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
