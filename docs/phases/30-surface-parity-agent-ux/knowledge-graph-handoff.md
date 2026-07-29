# 핸드오프 — 근거 관계 그래프를 계약에 노출

> **상태:** 미구현. 다른 에이전트가 이어받도록 작성한 인계 문서
> **작성일:** 2026-07-27
> **관련:** [제품 헌법 9.6 지식·그래프·RAG·기억](../../product/constitution.md)

## 1. 무엇이 없는가

**도메인은 관계를 이미 갖고 있고, 계약이 하나도 노출하지 않습니다.** 여섯 번 반복된 것과 같은 패턴의 일곱 번째 사례입니다.

| | 상태 | 근거 |
|---|---|---|
| 관계 추출 | 구현됨 | `packages/evidence/src/extractors.ts:31` — `contains \| imports \| calls \| implements \| documents` |
| 그래프 순회 | 구현됨 | `packages/evidence/src/graph.ts:29` `CodeGraphService.neighbors()` — depth 1~5, `outgoing \| incoming \| both`, 미해결 관계를 `unresolved`로 분리 |
| 생산 조립 | 구현됨 | `WorkspaceKnowledgeService`가 Repository·Indexer·Search·CodeGraph·EvidenceBrief를 Work intake에 연결 |
| **계약 노출** | **없음** | `WorkKnowledgeViewV1.references`(`contracts.ts:344`)는 평평한 목록. relation 필드도, graph 조회도 없음 |

그래서 화면은 "이 Work가 무엇을 읽었나"까지만 답하고 **"그것이 무엇과 엮여 있나"를 답할 수 없습니다.** 헌법 9.6이 v1 범위로 명시한 *"기존 relation을 1-hop 검색 확장에 사용"*이 화면에서는 보이지 않습니다.

## 2. 필요한 것

`KnowledgeReferenceViewV1`에 관계를 실어 보내십시오. 새 계산은 없습니다 — `CodeGraphService.neighbors()`를 `depth: 1`로 부르고 결과를 옮기면 됩니다.

```ts
// contracts.ts
export type KnowledgeRelationKindV1 = "contains" | "imports" | "calls" | "implements" | "documents";

export interface KnowledgeRelationViewV1 {
  readonly kind: KnowledgeRelationKindV1;
  readonly direction: "outgoing" | "incoming";
  readonly qualifiedName: string;
  readonly relativePath: string;
  /** CodeGraphResult.unresolved — 인덱스 밖을 가리키는 관계 */
  readonly unresolved?: boolean;
}

export interface KnowledgeReferenceViewV1 {
  // …기존 필드…
  readonly relations?: readonly KnowledgeRelationViewV1[];
}
```

**값은 도메인 열거값 그대로 보내십시오.** 한글 문구는 화면이 소유합니다(`apps/desktop/src/app.tsx` `knowledgeRelationLabel`). `calls`는 방향이 뒤집히면 뜻이 정반대가 되므로(부른다 ↔ 불린다) `direction`을 반드시 채우십시오. 화면 문구는 다섯 종류가 `이것이 …` / `이것을 …` 한 문형을 공유하고 방향이 조사로만 갈립니다.

**`unresolved`를 삼키지 마십시오.** 인덱스 밖(`node_modules` 등)을 가리키는 관계를 해결된 것처럼 보내면 화면이 없는 연결을 그립니다. 도메인이 이미 분리해 두었으니 그대로 전달하면 됩니다.

### 더 깊은 탐색(선택)

`depth > 1`이 필요해지면 조회를 따로 여십시오: `work.knowledge-graph`(payload `{ workId, symbolKey, direction, depth }` → `CodeGraphResult`). 지금 화면은 1-hop만 쓰므로 필요해질 때 열면 됩니다.

## 3. 범위 밖 — 명시적으로 열지 않은 것

헌법 9.6이 **측정된 실패가 있을 때만** 열라고 못 박은 것들입니다. 이 핸드오프는 그 문을 열지 않습니다.

- **LSP** — *"현재 저장소에는 LSP 구현이 없습니다. Tree-sitter+BM25+1-hop graph의 실제 UAT가 cross-file 정확도 때문에 반복 실패할 때만 LSP adapter 계획을 엽니다."*
- **embedding provider** — 검색 품질 실패가 측정될 때만
- **SurrealDB native relation 전환** — 순회 성능 실패가 측정될 때만. v1은 기존 relation 테이블 1-hop 확장을 씁니다

## 4. 프론트엔드 상태 — 연결만 하면 됩니다

완성본 기준으로 이미 그려져 있습니다.

| 계층 | 위치 |
|---|---|
| 뷰 타입 | `desktop-service.ts` `KnowledgeRelationView` · `KnowledgeReferenceView` · `WorkKnowledgeView` |
| 문구 | `app.tsx` `knowledgeRelationLabel` — kind × direction 10가지 |
| 렌더 | `app.tsx` `KnowledgeRelations` — 방향별 묶음 목록, 미해결은 `밖` 표시 |
| fixture | `desktop-service.ts` `fixtureKnowledge()` — 관계 5종 + 미해결 1건 |

**다이어그램을 쓰지 않았습니다.** 이 패널은 300px이고, 같은 폭에서 노드·선으로 그린 조직 지도가 이미 실패했습니다(잉크 0.65%, 라벨 불가). 여기서 답할 질문은 "모양"이 아니라 "무엇이 이것에 걸려 있나"라 묶음 목록이 더 정확히 답합니다. 깊은 탐색이 필요해지면 그때 별도 표면을 여십시오.

## 5. 완료 판정

- [ ] `KnowledgeReferenceViewV1.relations`가 계약에 있고 실제 Work에서 채워진다
- [ ] `direction`이 정확하다(호출한 쪽과 불린 쪽이 뒤바뀌지 않는다)
- [ ] `unresolved` 관계가 해결된 것으로 둔갑하지 않는다
- [ ] `desktop-service.ts`의 `fixtureKnowledge()`와 실제 데이터 모양이 일치한다
- [ ] 실제 Provider Work 하나에서 관계가 화면에 표시되는 증거를 `docs/evidence/phase-30/`에 남긴다
