import {
  ApplicationClient,
  agentIdentityToken,
  type ApprovalViewV1,
  type ArtifactViewV1,
  type AssignmentViewV1,
  type DirectiveViewV1,
  type ExplicitMemoryViewV1,
  type ExecutionViewV1,
  type ExtensionInstallationViewV1,
  type GovernanceAutonomyViewV1,
  type OrganizationGraphSnapshotV1,
  type RoomMessageViewV1,
  type RoomViewV1,
  type SharedContextViewV1,
  type RunViewV1,
  type TaskViewV1,
  type VerificationViewV1,
  type WorkActivityViewV1,
  type WorkDetailV1,
  type KnowledgeReferenceViewV1,
  type WorkKnowledgeViewV1,
  type WorkSummaryV1,
  type WorkspaceViewV1,
} from "@massion/application/client";

import {
  fixtureDataAdapter,
  type ActivityView,
  type AgentView,
  type ApprovalView,
  type ArtifactView,
  type DesktopSnapshot,
  type RoomBudgetView,
  type RoomView,
  type RunView,
  type SpeakerView,
  type StepState,
  type TaskView,
  type VerificationCriterionStatus,
  type VerificationCriterionView,
  type VerificationView,
  type WorkStatus,
  type WorkView,
} from "./model";
import type { NativeTransport } from "./native-transport";

export type DesktopBootstrapState = "ready";
export type DesktopStreamHandler = (payload: unknown) => void;
export type DesktopStreamStop = () => Promise<void>;
export type DirectiveMode = "now" | "next-stage";
export type ApprovalVote = "approve" | "reject";
export type DesktopFilter = "active" | "complete";

export interface WorkIndexInput {
  readonly filter: DesktopFilter;
  readonly search: string;
}

export interface StartWorkInput {
  readonly text: string;
  readonly workspaceId?: string;
  readonly workspacePaths?: readonly string[];
}

export type DesktopWorkspaceView = WorkspaceViewV1;

export interface StartedWork {
  readonly runId: string;
}

export interface OrganizationNodeView {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly parentHandle?: string;
  readonly status: string;
  readonly role: string;
  readonly capabilities: readonly string[];
  /** 이전 응답과의 호환을 위해 optional이지만, 실제 조직 snapshot 투영은 항상 값을 보존합니다. */
  readonly scope?: "persistent" | "work";
  readonly workId?: string;
}

export interface OrganizationView {
  readonly version?: number;
  readonly nodes: readonly OrganizationNodeView[];
}

export interface AutonomyView {
  readonly mode: "automatic" | "review" | "full-access";
  readonly revision: number;
  readonly runtimePermissionStatus: "governed" | "full-access" | "limited";
  readonly permissionLimitReason?: string;
  readonly emergencyStopActive: boolean;
}

export interface EmergencyView {
  readonly active: boolean;
  readonly reason?: string;
  readonly revision: number;
  readonly approvalId?: string;
}

export interface ExtensionView {
  readonly id: string;
  readonly packageName: string;
  readonly status: string;
  readonly activeVersionId?: string;
  readonly activationGeneration: number;
}

/**
 * 확장 표면의 뷰. 헌법 6절이 *"조직에 추가된 Capability를 먼저 보여줘야 한다"*고 요구하고,
 * 8절이 *"확장 화면은 설치 레코드 목록이며 Capability를 설명하지 않는다"*를 격차로 적어 뒀습니다.
 *
 * 도메인에는 있습니다 — `ExtensionContributionDeclaration`·`ExtensionPermissionDeclaration`
 * (`packages/extension-sdk/src/contracts.ts:16,27`). 계약이 노출하는 `ExtensionInstallationViewV1`은
 * 다섯 필드뿐이고 그중 어느 것도 Capability가 아닙니다.
 * 인계: docs/phases/30-surface-parity-agent-ux/extension-capability-handoff.md
 */
export type ContributionKind =
  | "runtimeTools"
  | "organizationTemplates"
  | "growthSignals"
  | "growthTargets"
  | "surfaceConnectors"
  | "eventConsumers"
  | "skills"
  | "modelEvaluationBundles";

export type PermissionKind = "tools" | "network" | "files" | "secrets" | "process" | "mcp" | "storage" | "events";

export interface ExtensionEntryView {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly description: string;
  /** official·verified·community. 설치 판단의 첫 근거입니다. */
  readonly provenance: string;
  readonly installed: boolean;
  /** 설치된 것만 가집니다. `ExtensionInstallationViewV1.state`. */
  readonly state?: string;
  readonly contributions: readonly { readonly kind: ContributionKind; readonly items: readonly string[] }[];
  readonly permissions: readonly { readonly kind: PermissionKind; readonly items: readonly string[] }[];
}

export interface ModelProfileView {
  readonly modelProfileId: string;
  readonly providerId: string;
  readonly endpointId: string;
  readonly modelId: string;
  readonly routeKind: string;
}

export interface RouteView {
  readonly routeId: string;
  readonly name: string;
  readonly routeKind: string;
}

export interface RouterCatalogView {
  readonly endpoints?: readonly {
    readonly endpointId: string;
    readonly providerId: string;
    readonly name: string;
    readonly baseUrl: string;
  }[];
  readonly models?: readonly ModelProfileView[];
}

export interface SettingsView {
  readonly catalog: unknown;
  readonly credentials: unknown;
  readonly routes: unknown;
  readonly providers: unknown;
  readonly accounts: unknown;
  readonly quota: unknown;
  readonly policy: unknown;
}

/*
 * 아래 셋은 `router.*`·`subscription.*` 조회가 실제로 돌려주는 모양입니다.
 * 조회는 등록돼 있지만 `ApplicationQueryMapV1`에 항목이 없어 데스크톱이 `unknown`으로 받습니다.
 * 그래서 화면이 런타임 파싱을 합니다. 계약이 타입을 주면 이 투영은 그대로 사라집니다.
 * 인계: docs/phases/30-surface-parity-agent-ux/settings-contract-handoff.md
 */

/** `router.routes` + `router.catalog.candidates`. 요청이 어느 모델로 가는지입니다. */
export interface ModelRouteView {
  readonly routeId: string;
  readonly name: string;
  readonly routeKind: string;
  readonly enabled: boolean;
  readonly spentMicros: number;
  readonly totalBudgetMicros: number;
  /** 이 경로가 쓸 수 있는 모델 수. 0이면 경로가 있어도 실행되지 않습니다. */
  readonly candidateCount: number;
  /** 우선순위가 가장 높은 후보의 모델 id. 이 경로가 실제로 부르는 모델입니다. */
  readonly primaryModelId?: string;
  /** 그 모델이 이 컴퓨터에서 도는지. 로컬 우선 제품이라 데이터가 나가는지가 먼저 보여야 합니다. */
  readonly primaryLocal?: boolean;
  /** 그 모델 프로필이 검증됐는지. */
  readonly primaryVerified?: boolean;
}

/*
 * ── 근거 그래프 ───────────────────────────────────────────────────
 *
 * 도메인은 관계를 이미 갖고 있습니다: `packages/evidence/src/extractors.ts:31`이
 * `contains | imports | calls | implements | documents`를 뽑고,
 * `CodeGraphService.neighbors()`(graph.ts:29)가 depth 1~5로 실제 순회합니다.
 *
 * **계약이 이를 하나도 노출하지 않습니다.** `WorkKnowledgeViewV1.references`는 평평한 목록이고
 * graph 조회 자체가 없습니다. 아래 타입은 완성본 화면이 기다리는 모양이며,
 * 인계: docs/phases/30-surface-parity-agent-ux/knowledge-graph-handoff.md
 */

/** @massion/evidence의 relation kind. 한글 문구는 화면이 소유합니다. */
export type KnowledgeRelationKind = "contains" | "imports" | "calls" | "implements" | "documents";

export interface KnowledgeRelationView {
  readonly kind: KnowledgeRelationKind;
  /** outgoing = 이 심볼이 상대를 가리킴, incoming = 상대가 이 심볼을 가리킴. */
  readonly direction: "outgoing" | "incoming";
  readonly qualifiedName: string;
  readonly relativePath: string;
  /**
   * 인덱스 밖을 가리켜 아직 이어지지 않은 관계(`CodeGraphResult.unresolved`).
   * 없는 연결을 이어진 것처럼 그리지 않기 위해 그대로 표시합니다.
   */
  readonly unresolved?: boolean;
}

export interface KnowledgeReferenceView extends KnowledgeReferenceViewV1 {
  readonly relations?: readonly KnowledgeRelationView[];
}

export interface WorkKnowledgeView extends Omit<WorkKnowledgeViewV1, "references"> {
  readonly references: readonly KnowledgeReferenceView[];
}

/**
 * 완성본 기준 지식. 관계 셋을 한 이웃 목록으로 합친 모습입니다 —
 * 코드 관계(evidence)뿐 아니라 이 심볼을 쓴 Work·산출물·에이전트까지 한 자리에서 봅니다.
 * 그게 ADR-002가 말한 "합쳐진 이웃 조회"의 결과 모양입니다.
 */
const fixtureKnowledgeNodes: readonly KnowledgeNodeView[] = [
  { nodeId: "work:churn-q3", kind: "work", label: "3분기 고객 이탈 원인 분석", detail: "진행 중" },
  { nodeId: "work:partner-contract", kind: "work", label: "파트너 계약서 검토", detail: "막힘" },
  { nodeId: "work:weekly-ops", kind: "work", label: "주간 운영 보고서", detail: "진행 중" },
  {
    nodeId: "document:cohort-md",
    kind: "document",
    label: "코호트 정의 규칙",
    detail: "docs/analytics/cohort.md",
    group: "analytics",
  },
  { nodeId: "document:runbook-md", kind: "document", label: "운영 런북", detail: "docs/ops/runbook.md", group: "ops" },
  {
    nodeId: "document:metrics-md",
    kind: "document",
    label: "지표 사전",
    detail: "docs/analytics/metrics.md",
    group: "analytics",
  },
  { nodeId: "file:cohort-ts", kind: "file", label: "cohort.ts", detail: "src/analytics", group: "analytics" },
  { nodeId: "file:window-ts", kind: "file", label: "window.ts", detail: "src/analytics", group: "analytics" },
  { nodeId: "file:segment-ts", kind: "file", label: "segment.ts", detail: "src/analytics", group: "analytics" },
  { nodeId: "file:churn-ts", kind: "file", label: "churn.ts", detail: "src/report", group: "report" },
  { nodeId: "file:ports-ts", kind: "file", label: "ports.ts", detail: "src/analytics", group: "analytics" },
  { nodeId: "symbol:resolveCohort", kind: "symbol", label: "resolveCohort", detail: "cohort.ts:42–88" },
  { nodeId: "symbol:normalizeWindow", kind: "symbol", label: "normalizeWindow", detail: "window.ts:12–39" },
  { nodeId: "symbol:loadSegments", kind: "symbol", label: "loadSegments", detail: "segment.ts:8–51" },
  { nodeId: "symbol:buildChurnReport", kind: "symbol", label: "buildChurnReport", detail: "churn.ts:20–96" },
  { nodeId: "symbol:CohortResolver", kind: "symbol", label: "CohortResolver", detail: "ports.ts:5–18" },
  { nodeId: "artifact:churn-brief", kind: "artifact", label: "라벨링 기준 브리프", detail: "evidence-brief" },
];

/**
 * 하나의 평평한 간선 목록. 관계 저장소 셋(evidence·organization·growth)을 합치면
 * 이 모양이 됩니다. 렌즈별 그래프와 노드별 연결 목록을 둘 다 여기서 파생합니다.
 */
const fixtureKnowledgeEdges: readonly KnowledgeGraphEdgeView[] = [
  { kind: "contains", sourceId: "file:cohort-ts", targetId: "symbol:resolveCohort" },
  { kind: "contains", sourceId: "file:window-ts", targetId: "symbol:normalizeWindow" },
  { kind: "contains", sourceId: "file:segment-ts", targetId: "symbol:loadSegments" },
  { kind: "contains", sourceId: "file:churn-ts", targetId: "symbol:buildChurnReport" },
  { kind: "contains", sourceId: "file:ports-ts", targetId: "symbol:CohortResolver" },
  { kind: "calls", sourceId: "symbol:resolveCohort", targetId: "symbol:normalizeWindow" },
  { kind: "calls", sourceId: "symbol:resolveCohort", targetId: "symbol:loadSegments" },
  { kind: "calls", sourceId: "symbol:buildChurnReport", targetId: "symbol:resolveCohort" },
  { kind: "implements", sourceId: "symbol:resolveCohort", targetId: "symbol:CohortResolver" },
  // 파일끼리는 import가 실재하는 동종 관계입니다.
  { kind: "imports", sourceId: "file:churn-ts", targetId: "file:cohort-ts" },
  { kind: "imports", sourceId: "file:cohort-ts", targetId: "file:window-ts" },
  { kind: "imports", sourceId: "file:cohort-ts", targetId: "file:segment-ts" },
  { kind: "imports", sourceId: "file:cohort-ts", targetId: "file:ports-ts" },
  // 문서끼리도 서로를 가리킵니다.
  { kind: "documents", sourceId: "document:cohort-md", targetId: "document:metrics-md" },
  { kind: "documents", sourceId: "document:runbook-md", targetId: "document:metrics-md" },
  { kind: "documents", sourceId: "document:cohort-md", targetId: "symbol:resolveCohort" },
  { kind: "documents", sourceId: "document:cohort-md", targetId: "file:cohort-ts" },
  // 코드 밖 관계. 저장소를 합쳐야만 한 그래프에 나옵니다.
  { kind: "documents", sourceId: "work:churn-q3", targetId: "file:cohort-ts" },
  { kind: "documents", sourceId: "work:churn-q3", targetId: "file:churn-ts" },
  { kind: "documents", sourceId: "work:churn-q3", targetId: "document:cohort-md" },
  { kind: "documents", sourceId: "work:churn-q3", targetId: "artifact:churn-brief" },
  { kind: "documents", sourceId: "work:weekly-ops", targetId: "document:runbook-md" },
  { kind: "documents", sourceId: "work:weekly-ops", targetId: "file:churn-ts" },
  { kind: "documents", sourceId: "work:weekly-ops", targetId: "document:metrics-md" },
  { kind: "documents", sourceId: "work:partner-contract", targetId: "document:runbook-md" },
];

/*
 * 규모 시험용 더미. 색인 상태가 말하는 수(파일 214 · 심볼 1,836)와 실제 노드 수를 맞춥니다.
 * 화면이 "관계 4,902"라고 써놓고 노드 다섯 개만 그리면 규모에서 무엇이 무너지는지 알 수 없습니다.
 *
 * 난수를 쓰지 않습니다. 시드가 인덱스인 LCG라 다시 열어도 같은 그래프가 나옵니다.
 */
function seeded(index: number): number {
  const value = Math.sin(index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

const FILE_AREAS = ["analytics", "report", "ingest", "billing", "auth", "ops", "ui", "shared"] as const;

function buildScaleNodes(): { nodes: KnowledgeNodeView[]; edges: KnowledgeGraphEdgeView[] } {
  const nodes: KnowledgeNodeView[] = [];
  const edges: KnowledgeGraphEdgeView[] = [];

  // 파일 214개. 손으로 쓴 다섯 개는 앞에 두어 이름으로 찾을 수 있게 합니다.
  const handFiles = fixtureKnowledgeNodes.filter((node) => node.kind === "file");
  for (let i = handFiles.length; i < 214; i += 1) {
    const area = FILE_AREAS[i % FILE_AREAS.length] ?? "shared";
    nodes.push({
      nodeId: `file:gen-${String(i)}`,
      kind: "file",
      label: `${area}-${String(i)}.ts`,
      detail: `src/${area}`,
      group: area,
    });
  }
  // 심볼 1,836개.
  const handSymbols = fixtureKnowledgeNodes.filter((node) => node.kind === "symbol");
  for (let i = handSymbols.length; i < 1836; i += 1) {
    const area = FILE_AREAS[i % FILE_AREAS.length] ?? "shared";
    nodes.push({
      nodeId: `symbol:gen-${String(i)}`,
      kind: "symbol",
      label: `${area}Handler${String(i)}`,
      detail: `${area}-${String(i % 214)}.ts`,
      group: area,
    });
  }
  // 문서 40개.
  const handDocs = fixtureKnowledgeNodes.filter((node) => node.kind === "document");
  for (let i = handDocs.length; i < 40; i += 1) {
    nodes.push({
      nodeId: `document:gen-${String(i)}`,
      kind: "document",
      label: `설계 노트 ${String(i)}`,
      detail: `docs/notes/${String(i)}.md`,
      group: "notes",
    });
  }

  const files = [...handFiles, ...nodes.filter((node) => node.kind === "file")];
  const symbols = [...handSymbols, ...nodes.filter((node) => node.kind === "symbol")];
  const docs = [...handDocs, ...nodes.filter((node) => node.kind === "document")];

  // 파일끼리 import. 앞쪽 파일을 더 많이 물리게 해서 허브가 생기게 합니다(실제 코드가 그렇습니다).
  for (let i = 1; i < files.length; i += 1) {
    const links = 1 + Math.floor(seeded(i) * 3);
    for (let n = 0; n < links; n += 1) {
      const targetIndex = Math.floor(seeded(i * 7 + n) ** 2 * i);
      const source = files[i];
      const target = files[targetIndex];
      if (!source || !target || source.nodeId === target.nodeId) continue;
      edges.push({ kind: "imports", sourceId: source.nodeId, targetId: target.nodeId });
    }
  }
  // 심볼끼리 call.
  for (let i = 1; i < symbols.length; i += 1) {
    const links = 1 + Math.floor(seeded(i * 3) * 2);
    for (let n = 0; n < links; n += 1) {
      const targetIndex = Math.floor(seeded(i * 11 + n) ** 2 * i);
      const source = symbols[i];
      const target = symbols[targetIndex];
      if (!source || !target || source.nodeId === target.nodeId) continue;
      edges.push({ kind: "calls", sourceId: source.nodeId, targetId: target.nodeId });
    }
  }
  // 문서끼리 참조.
  for (let i = 1; i < docs.length; i += 1) {
    const source = docs[i];
    const target = docs[Math.floor(seeded(i * 5) * i)];
    if (!source || !target || source.nodeId === target.nodeId) continue;
    edges.push({ kind: "documents", sourceId: source.nodeId, targetId: target.nodeId });
  }
  return { nodes, edges };
}

const scale = buildScaleNodes();
const allKnowledgeNodes: readonly KnowledgeNodeView[] = [...fixtureKnowledgeNodes, ...scale.nodes];
const allKnowledgeEdges: readonly KnowledgeGraphEdgeView[] = [...fixtureKnowledgeEdges, ...scale.edges];

/**
 * 렌즈 그래프. **같은 종류끼리만 잇습니다.** 업무 지도에는 업무만, 파일 지도에는 파일만 있습니다.
 * 이종 연결(업무↔문서↔파일↔심볼)은 캔버스가 아니라 노드를 눌렀을 때 시트가 보여줍니다.
 *
 * 같은 종류를 잇는 근거는 둘입니다.
 *  - 직접: 파일의 `imports`, 심볼의 `calls`·`implements`처럼 도메인에 실재하는 동종 관계
 *  - 공유: 같은 것을 쓴 사이. 업무끼리가 여기 해당합니다 — 같은 파일을 건드린 업무는 이어져 있습니다
 */
function fixtureGraph(lens: KnowledgeNodeKind): KnowledgeGraphView {
  const nodes = allKnowledgeNodes.filter((node) => node.kind === lens);
  const ids = new Set(nodes.map((node) => node.nodeId));
  const label = new Map(allKnowledgeNodes.map((node) => [node.nodeId, node.label]));

  const direct = allKnowledgeEdges.filter((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId));
  const seen = new Set(direct.map((edge) => [edge.sourceId, edge.targetId].sort().join("|")));

  // 이웃을 공유하는 쌍을 찾습니다. 방향이 없으므로 한 쌍당 하나만 만듭니다.
  const neighbors = new Map<string, Set<string>>();
  for (const edge of allKnowledgeEdges) {
    for (const [self, other] of [
      [edge.sourceId, edge.targetId],
      [edge.targetId, edge.sourceId],
    ] as const) {
      if (!ids.has(self) || ids.has(other)) continue;
      neighbors.set(self, (neighbors.get(self) ?? new Set()).add(other));
    }
  }
  const derived: KnowledgeGraphEdgeView[] = [];
  const list = [...neighbors];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const first = list[i];
      const second = list[j];
      if (!first || !second) continue;
      const [leftId, left] = first;
      const [rightId, right] = second;
      const key = [leftId, rightId].sort().join("|");
      if (seen.has(key)) continue;
      const shared = [...left].find((id) => right.has(id));
      if (shared === undefined) continue;
      seen.add(key);
      derived.push({
        kind: "documents",
        sourceId: leftId,
        targetId: rightId,
        derivedVia: label.get(shared) ?? shared,
      });
    }
  }
  return { lens, nodes, edges: [...direct, ...derived] };
}

/** 노드 하나의 전체 연결. 렌즈로 좁히지 않습니다. */
function fixtureLinks(nodeId: string): readonly KnowledgeLinkView[] {
  const byId = new Map(allKnowledgeNodes.map((node) => [node.nodeId, node]));
  return allKnowledgeEdges.flatMap((edge) => {
    const otherId = edge.sourceId === nodeId ? edge.targetId : edge.targetId === nodeId ? edge.sourceId : undefined;
    if (otherId === undefined) return [];
    const node = byId.get(otherId);
    if (!node) return [];
    return [
      {
        node,
        kind: edge.kind,
        direction: edge.sourceId === nodeId ? ("outgoing" as const) : ("incoming" as const),
        ...(edge.unresolved === true ? { unresolved: true } : {}),
      },
    ];
  });
}

/**
 * 완성본 기준 근거. 워크스페이스를 고른 Work만 지식을 씁니다.
 * 실 경로는 관계를 못 받으므로 `relations`가 비고, 화면은 목록만 그립니다.
 */
function fixtureKnowledge(workId: string): WorkKnowledgeView {
  if (workId !== "churn-q3") return { workId, status: "not-applicable", references: [] };
  return {
    workId,
    status: "ready",
    repositoryId: "repository-analytics",
    repositoryRevisionId: "revision-8f21c4",
    indexVersionId: "index-2f9a10",
    evidenceBriefId: "evidence-brief-churn",
    freshnessStatus: "fresh",
    query: "코호트 정의 이탈 집계",
    references: [
      {
        referenceId: "reference-cohort",
        kind: "symbol",
        relativePath: "src/analytics/cohort.ts",
        qualifiedName: "resolveCohort",
        startLine: 42,
        endLine: 88,
        contentHash: "a3f1c8",
        relations: [
          {
            kind: "calls",
            direction: "outgoing",
            qualifiedName: "normalizeWindow",
            relativePath: "src/analytics/window.ts",
          },
          {
            kind: "calls",
            direction: "outgoing",
            qualifiedName: "loadSegments",
            relativePath: "src/analytics/segment.ts",
          },
          {
            kind: "calls",
            direction: "incoming",
            qualifiedName: "buildChurnReport",
            relativePath: "src/report/churn.ts",
          },
          {
            kind: "calls",
            direction: "incoming",
            qualifiedName: "compareQuarters",
            relativePath: "src/report/compare.ts",
          },
          {
            kind: "implements",
            direction: "outgoing",
            qualifiedName: "CohortResolver",
            relativePath: "src/analytics/ports.ts",
          },
          {
            kind: "documents",
            direction: "incoming",
            qualifiedName: "코호트 정의 규칙",
            relativePath: "docs/analytics/cohort.md",
          },
        ],
      },
      {
        referenceId: "reference-window",
        kind: "symbol",
        relativePath: "src/analytics/window.ts",
        qualifiedName: "normalizeWindow",
        startLine: 12,
        endLine: 39,
        contentHash: "7c02b1",
        relations: [
          {
            kind: "imports",
            direction: "outgoing",
            qualifiedName: "startOfQuarter",
            relativePath: "src/time/quarter.ts",
          },
          {
            kind: "calls",
            direction: "incoming",
            qualifiedName: "resolveCohort",
            relativePath: "src/analytics/cohort.ts",
          },
          // 인덱스 밖을 가리키는 관계는 이어진 것처럼 그리지 않고 그대로 남깁니다.
          {
            kind: "calls",
            direction: "outgoing",
            qualifiedName: "dayjs",
            relativePath: "node_modules",
            unresolved: true,
          },
        ],
      },
      {
        referenceId: "reference-churn-doc",
        kind: "chunk",
        relativePath: "docs/analytics/cohort.md",
        startLine: 1,
        endLine: 34,
        contentHash: "5be914",
        relations: [
          {
            kind: "documents",
            direction: "outgoing",
            qualifiedName: "resolveCohort",
            relativePath: "src/analytics/cohort.ts",
          },
        ],
      },
    ],
  };
}

/*
 * ── 지식 표면 (ADR-002) ──────────────────────────────────────────
 *
 * 관계 저장소가 셋으로 갈려 있습니다: evidence(코드 관계), organization(OrganizationReference),
 * growth(source_reference_ids). 단일 간선 테이블이 없으므로 **application 계층 조인**으로
 * 하나의 이웃 조회를 만들어야 합니다. SurrealDB native relation은 §9.6이 성능 실패가
 * 측정될 때만 열라고 했으므로 여기서 열지 않습니다.
 *
 * 인계: docs/phases/30-surface-parity-agent-ux/knowledge-surface-handoff.md
 */

/** 마인드맵 노드가 가리킬 수 있는 것. 코드에 한정하지 않습니다. */
export type KnowledgeNodeKind = "symbol" | "file" | "document" | "work" | "artifact" | "agent";

export interface KnowledgeNodeView {
  readonly nodeId: string;
  readonly kind: KnowledgeNodeKind;
  /** 사람이 읽는 이름. 심볼이면 qualifiedName, 파일이면 파일명. */
  readonly label: string;
  /** 어디에 있는지. 파일 경로이거나 Work 제목입니다. */
  readonly detail?: string;
  /**
   * 색을 나누는 기준. 보통 폴더입니다(옵시디언이 폴더로 묶는 것과 같습니다).
   * 무작위 색이 아니라 이것으로 칠해야 뭉친 색덩이가 실제 구조를 뜻하게 됩니다.
   */
  readonly group?: string;
}

/** 그래프 간선. 방향은 source→target이고, 화면이 중심에 따라 안팎을 정합니다. */
export interface KnowledgeGraphEdgeView {
  readonly kind: KnowledgeRelationKind;
  readonly sourceId: string;
  readonly targetId: string;
  /** 인덱스 밖을 가리켜 아직 이어지지 않은 관계. 이어진 것처럼 그리지 않습니다. */
  readonly unresolved?: boolean;
  /**
   * 직접 관계가 아니라 **공유한 것**으로 이어진 경우 그 이름.
   * 업무끼리는 서로를 부르지 않습니다 — 같은 파일·문서를 썼기 때문에 이어집니다.
   * 왜 이어졌는지 말하지 못하면 사용자에게는 우연한 선으로 보입니다.
   */
  readonly derivedVia?: string;
}

/**
 * 렌즈 하나의 그래프. 렌즈는 "무엇의 지도를 볼 것인가"이고,
 * 그 종류의 노드와 거기 직접 걸린 것만 담습니다. 전체를 담지 않습니다.
 */
export interface KnowledgeGraphView {
  readonly lens: KnowledgeNodeKind;
  readonly nodes: readonly KnowledgeNodeView[];
  readonly edges: readonly KnowledgeGraphEdgeView[];
}

/** 시트가 보여주는 "무엇과 이어져 있나" 한 줄. */
export interface KnowledgeLinkView {
  readonly node: KnowledgeNodeView;
  readonly kind: KnowledgeRelationKind;
  readonly direction: "outgoing" | "incoming";
  readonly unresolved?: boolean;
}

/** 워크스페이스가 무엇으로 색인됐나. */
export interface KnowledgeIndexView {
  readonly workspaceId: string;
  readonly status: "ready" | "indexing" | "stale" | "none";
  readonly indexVersionId?: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly relationCount: number;
  readonly indexedAt?: string;
  /** 색인에서 빠진 것. 없는 것을 아는 것도 지식입니다. */
  readonly excluded: readonly string[];
}

/** `router.catalog.providers` + `.endpoints`. */
export interface ProviderConnectionView {
  readonly providerId: string;
  readonly displayName: string;
  readonly adapterKind: string;
  readonly enabled: boolean;
  readonly endpoints: readonly { readonly name: string; readonly baseUrl: string; readonly local: boolean }[];
}

/** `subscription.accounts`. quota가 계정 행에 함께 실려 옵니다. */
export interface SubscriptionAccountView {
  readonly accountId: string;
  readonly providerId: string;
  readonly alias: string;
  readonly status: string;
  readonly billingKind: string;
  readonly quotaExhausted?: boolean;
  /** 0~1. 여러 창(window) 중 가장 적게 남은 비율입니다. */
  readonly minimumRemainingRatio?: number;
  readonly earliestResetAt?: string;
  readonly cooldownUntil?: string;
}

export interface ZaiCodingPlanConnectionInput {
  readonly alias: string;
  readonly secret: string;
}

export interface CapabilitiesView {
  readonly extensions: readonly ExtensionView[];
  readonly inventory: unknown;
}

/**
 * 아래 세 타입은 도메인(`packages/growth`)에는 있고 Application 계약에는 아직 없습니다.
 * 완성본 기준으로 화면을 먼저 고정하기 위한 뷰이며, 계약이 넓어지면 그대로 채워집니다.
 * 인계: docs/phases/30-surface-parity-agent-ux/growth-adoption-handoff.md
 */
export interface GrowthSignalView {
  readonly signalId: string;
  /** required는 통과 필수, conflict는 반대 근거입니다. */
  readonly group: "required" | "supporting" | "conflict";
  /** model-self는 모델의 자기평가입니다. 독립 신호와 같은 무게로 그리면 안 됩니다. */
  readonly origin: "deterministic" | "independent" | "model-self";
  readonly outcome: "passed" | "failed" | "unavailable";
  readonly score: number;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly note: string;
  readonly sourceId?: string;
  readonly sourceChecksum?: string;
  readonly fresh?: boolean;
}

export interface GrowthEvaluationView {
  readonly evaluationRunId: string;
  readonly outcome: "eligible" | "ineligible" | "blocked";
  readonly strategyVersionId: string;
  readonly inputHash?: string;
  readonly signals: readonly GrowthSignalView[];
}

export interface GrowthAdoptionView {
  readonly adoptionId: string;
  readonly status: string;
  readonly commandId: string;
  readonly approvalId?: string;
  readonly evaluationRunId: string;
  readonly evaluationInputHash: string;
  readonly beforeVersionId: string;
  readonly beforeChecksum: string;
  readonly afterVersionId?: string;
  readonly afterChecksum?: string;
}

export interface GrowthPatchLineView {
  /** 조직 노드 handle. 있으면 화면이 에이전트 이름으로 풉니다. */
  readonly targetHandle?: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export interface GrowthEffectMeasureView {
  readonly score: number;
  readonly observationCount: number;
  readonly minimumObservations: number;
  readonly unit: string;
  readonly direction: "higher" | "lower";
  readonly baseline: number;
}

export interface GrowthView {
  readonly configuration?: {
    readonly reflectionEnabled: boolean;
    readonly adoptionMode: "review" | "auto";
    readonly version?: number;
    readonly governanceDecisionId: string;
    readonly activatedAt: string;
  };
  readonly memories: readonly ExplicitMemoryViewV1[];
  readonly suggestions: readonly {
    readonly suggestionId: string;
    readonly workId: string;
    readonly targetKind: string;
    readonly operation: string;
    readonly summary: string;
    readonly rationale: string;
    readonly expectedEffect: string;
    readonly riskSummary: string;
    readonly status: string;
    readonly revision?: number;
    readonly createdAt?: string;
    /** 원인 Event·Evidence. 도메인 `source_reference_ids`. */
    readonly sourceReferenceIds?: readonly string[];
    readonly reflectionRunId?: string;
    /** 도메인 `patch_json`을 줄 단위로 푼 것. */
    readonly patch?: readonly GrowthPatchLineView[];
    readonly evaluation?: GrowthEvaluationView;
    readonly adoption?: GrowthAdoptionView;
    /** 제안 당시 대상 checksum과 현재가 어긋나면 채택할 수 없습니다. */
    readonly targetDrifted?: boolean;
    readonly beforeVersionId?: string;
    readonly afterVersionId?: string;
  }[];
  readonly effects: readonly {
    readonly effectEvaluationId: string;
    readonly adoptionId: string;
    readonly result: "improved" | "stable" | "degraded" | "inconclusive";
    readonly suggestionId?: string;
    readonly measure?: GrowthEffectMeasureView;
  }[];
}

export interface RegistryInstallView {
  readonly outcome: string;
  readonly installationId?: string;
  readonly approvalId?: string;
}

// 승인 대기 command는 payload 일부가 바뀌어도 같은 실행 계보를 이어야 합니다.
export interface CommandIdentity {
  readonly commandId: string;
  readonly correlationId: string;
}

export interface DesktopService {
  readonly initialSnapshot?: DesktopSnapshot;
  bootstrap(): Promise<DesktopBootstrapState>;
  loadIndex(input: WorkIndexInput): Promise<WorkView[]>;
  loadWork(workId: string): Promise<WorkView>;
  loadWorkKnowledge(workId: string): Promise<WorkKnowledgeView>;
  /** 워크스페이스 색인 상태. 계약 없음 — ADR-002 인계 문서 참조. */
  loadKnowledgeIndex(workspaceId: string): Promise<KnowledgeIndexView>;
  /** 중심 하나의 이웃. 계약 없음 — application 계층 조인이 필요합니다. */
  loadKnowledgeGraph(workspaceId: string, lens: KnowledgeNodeKind): Promise<KnowledgeGraphView>;
  /**
   * 노드 하나가 무엇과 이어져 있나. **렌즈와 무관하게 전부** 돌려줍니다.
   * 지도는 렌즈로 좁혀 보지만, 고른 것의 연결까지 좁히면 "여러 업무·여러 문서에 걸려 있다"를
   * 볼 수 없게 됩니다. 계약 없음 — 인계 문서 참조.
   */
  loadKnowledgeLinks(workspaceId: string, nodeId: string): Promise<readonly KnowledgeLinkView[]>;
  loadPendingApprovals(): Promise<ApprovalView[]>;
  loadWorkspaces(): Promise<readonly DesktopWorkspaceView[]>;
  registerWorkspace(path: string): Promise<DesktopWorkspaceView>;
  decideWorkspaceTrust(workspace: DesktopWorkspaceView, decision: "trusted" | "blocked"): Promise<DesktopWorkspaceView>;
  loadOrganization(): Promise<OrganizationView>;
  /**
   * 이 Work의 모든 협업방과 각 방의 메시지.
   * 한 Work에 방이 여럿일 수 있습니다. 에이전트끼리 직접 붙는 2인 방도 같은 방입니다.
   */
  loadRooms(workId: string): Promise<RoomView[]>;
  loadAutonomy(): Promise<AutonomyView>;
  setAutonomy(mode: AutonomyView["mode"], expectedRevision: number): Promise<AutonomyView>;
  loadEmergency(): Promise<EmergencyView>;
  activateEmergency(reason: string): Promise<EmergencyView>;
  releaseEmergency(approvalId: string | undefined, reason: string): Promise<EmergencyView>;
  loadSettings(): Promise<SettingsView>;
  connectZaiCodingPlan(input: ZaiCodingPlanConnectionInput): Promise<void>;
  registerProvider(input: Record<string, unknown>): Promise<void>;
  registerEndpoint(input: Record<string, unknown>): Promise<void>;
  addCredential(input: Record<string, unknown>): Promise<void>;
  disableCredential(credentialId: string, expectedVersion: number): Promise<void>;
  registerModel(input: Record<string, unknown>): Promise<void>;
  configureRoute(input: Record<string, unknown>): Promise<void>;
  addRouteCandidate(input: Record<string, unknown>): Promise<void>;
  configureSubscriptionPolicy(input: Record<string, unknown>): Promise<void>;
  searchRegistry(query: string, limit?: number): Promise<unknown>;
  loadRegistryInfo(versionId: string): Promise<unknown>;
  loadCapabilities(): Promise<CapabilitiesView>;
  /** 설치된 확장과 마켓플레이스 항목을 하나의 목록으로 줍니다. Capability가 먼저입니다. */
  loadExtensions(): Promise<readonly ExtensionEntryView[]>;
  loadGrowth(): Promise<GrowthView>;
  configureGrowth(input: {
    readonly reflectionEnabled: boolean;
    readonly adoptionMode: "review" | "auto";
    readonly expectedVersion?: number;
  }): Promise<void>;
  approveGrowthSuggestion(input: {
    readonly suggestionId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<void>;
  rejectGrowthSuggestion(input: {
    readonly suggestionId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<void>;
  putExplicitMemory(input: {
    readonly key: string;
    readonly kind: ExplicitMemoryViewV1["entries"][number]["kind"];
    readonly value: string;
    readonly revision: number;
  }): Promise<void>;
  forgetExplicitMemory(input: { readonly key: string; readonly revision: number }): Promise<void>;
  installRegistry(input: Record<string, unknown>, identity?: CommandIdentity): Promise<RegistryInstallView>;
  submitDirective(work: WorkView, content: string, mode: DirectiveMode): Promise<void>;
  decideApproval(approval: ApprovalView, vote: ApprovalVote, reason: string): Promise<void>;
  cancelRun(work: WorkView): Promise<void>;
  resumeRun(work: WorkView): Promise<void>;
  startWork(input: StartWorkInput): Promise<StartedWork>;
  subscribeDurable(handler: DesktopStreamHandler, after?: number): Promise<DesktopStreamStop>;
  subscribeExecution(executionId: string, handler: DesktopStreamHandler): Promise<DesktopStreamStop>;
}

export interface ApplicationDesktopServiceOptions {
  readonly createId?: () => string;
}

const ACTIVE_RUN_STATUSES = new Set(["ready", "running", "awaiting-approval", "blocked"]);

const ACTIVE_EXECUTION_STATUSES = new Set(["active", "running"]);
const ACTIVE_AGENT_STATUSES = new Set(["active", "assigned", "running"]);

export function createApplicationDesktopService(
  native: NativeTransport,
  options: ApplicationDesktopServiceOptions = {},
): DesktopService {
  const client =
    options.createId === undefined ? new ApplicationClient(native) : new ApplicationClient(native, options.createId);
  const createId = options.createId ?? (() => crypto.randomUUID());
  const query = async (operation: string, payload: unknown): Promise<unknown> => {
    const response = object(await native.query(operation, payload));
    if (response?.operation !== operation || !("data" in response))
      throw new Error("Application query 응답이 유효하지 않습니다");
    return response.data;
  };
  const command = async (operation: string, payload: Record<string, unknown>, requestedIdentity?: CommandIdentity) => {
    const commandId = requestedIdentity?.commandId ?? createId();
    const correlationId = requestedIdentity?.correlationId ?? createId();
    const response = object(
      await native.command({ schemaVersion: "massion.application.v1", commandId, correlationId, operation, payload }),
    );
    if (
      response?.operation !== operation ||
      response.commandId !== commandId ||
      response.correlationId !== correlationId
    )
      throw new Error("Application command 응답 계보가 일치하지 않습니다");
    return response;
  };

  return {
    async bootstrap() {
      const response = object(await native.bootstrap());
      const status = object(response?.connection)?.status;
      if (status === "connected") return "ready";
      throw new Error("Desktop bootstrap 연결 상태가 유효하지 않습니다");
    },

    async loadIndex(input) {
      const page = await client.query("work.index", {
        search: input.search,
        limit: 50,
      });
      return page.items.map(projectWorkSummary).filter((work) => workStatusFilter(work.status) === input.filter);
    },

    async loadWork(workId) {
      const [
        detail,
        runs,
        activityPage,
        tasks,
        assignments,
        executions,
        artifacts,
        verifications,
        approvals,
        directives,
      ] = await Promise.all([
        client.query("work.detail", { workId }),
        client.query("run.list", { workId }),
        client.query("work.activity.list", { workId }),
        client.query("work.tasks", { workId }),
        client.query("work.assignments", { workId }),
        client.query("work.executions", { workId }),
        client.query("work.artifacts", { workId }),
        client.query("work.verifications", { workId }),
        client.query("governance.approval.list", { workId }),
        client.query("work.directive.list", { workId }),
      ]);

      return projectWorkDetail({
        detail,
        runs,
        activities: activityPage.items,
        tasks,
        assignments,
        executions,
        artifacts,
        verifications,
        approvals,
        directives,
      });
    },

    async loadWorkKnowledge(workId) {
      return await client.query("work.knowledge", { workId });
    },

    /*
     * 아래 둘은 계약이 아직 없습니다(ADR-002). 없는 조회를 부르는 대신 "모른다"를 돌려주고
     * 화면이 그 사실을 말하게 합니다. 숫자 0으로 색인된 척하지 않습니다.
     */
    loadKnowledgeIndex: (workspaceId) =>
      Promise.resolve({
        workspaceId,
        status: "none" as const,
        fileCount: 0,
        symbolCount: 0,
        relationCount: 0,
        excluded: [],
      }),
    loadKnowledgeGraph: (workspaceId, lens) => Promise.resolve({ lens, nodes: [], edges: [] }),
    loadKnowledgeLinks: () => Promise.resolve([]),

    async loadPendingApprovals() {
      return (await client.query("governance.approval.list", { status: "pending" })).map(projectApproval);
    },

    async loadWorkspaces() {
      return (await client.query("workspace.list", {})).map(workspaceView);
    },

    async registerWorkspace(path) {
      const result = await client.command("workspace.register", { path });
      return workspaceView(result.data);
    },

    async decideWorkspaceTrust(workspace, decision) {
      const result = await client.command(
        "workspace.trust",
        { workspaceId: workspace.workspaceId, decision },
        { expectedRevision: workspace.revision },
      );
      return workspaceView(result.data);
    },

    async loadOrganization() {
      return projectOrganization(await client.query("organization.graph.snapshot", {}));
    },

    async loadRooms(workId) {
      const [rooms, snapshot, sharedContexts] = await Promise.all([
        client.query("work.rooms", { workId }),
        client.query("organization.graph.snapshot", {}),
        client.query("work.shared-contexts", { workId }),
      ]);
      if (rooms.length === 0) return [];
      const nodes = projectOrganization(snapshot).nodes;
      const messageSets = await Promise.all(
        rooms.map(async (room) => client.query("work.messages", { workId, roomId: room.roomId })),
      );
      return withRoomReferences(
        rooms.map((room, index) => projectRoom(room, messageSets[index] ?? [], nodes, sharedContexts)),
      );
    },

    async loadAutonomy() {
      return projectAutonomy(await client.query("governance.autonomy", {}));
    },

    async setAutonomy(mode, expectedRevision) {
      const result = await client.command("governance.autonomy.set", { mode }, { expectedRevision });
      return projectAutonomy(object(result.data));
    },

    async loadEmergency() {
      return projectEmergency(await client.query("governance.emergency", {}));
    },

    async activateEmergency(reason) {
      const result = await client.command("governance.emergency.activate", { reason });
      return projectEmergency(result.data);
    },

    async releaseEmergency(approvalId, reason) {
      const result = await client.command(
        "governance.emergency.release",
        approvalId === undefined ? { reason } : { approvalId, reason },
      );
      return projectEmergency(result.data);
    },

    async loadSettings() {
      const [catalog, credentials, routes, providers, accounts, quota, policy] = await Promise.all([
        query("router.catalog", {}),
        query("router.credentials", {}),
        query("router.routes", {}),
        query("subscription.providers", {}),
        query("subscription.accounts", {}),
        query("subscription.quota", {}),
        query("subscription.policy", {}),
      ]);
      return {
        catalog: safeView(catalog),
        credentials: safeView(credentials),
        routes: safeView(routes),
        providers: safeView(providers),
        accounts: safeView(accounts),
        quota: safeView(quota),
        policy: safeView(policy),
      };
    },

    async connectZaiCodingPlan(input) {
      await command("subscription.server.connect-model", {
        providerId: "zai-coding-plan",
        alias: input.alias,
        authKind: "api-key",
        billingKind: "coding-plan",
        secret: input.secret,
      });
    },
    async registerProvider(input) {
      await command("router.provider.register", input);
    },
    async registerEndpoint(input) {
      await command("router.endpoint.register", input);
    },
    async addCredential(input) {
      await command("router.credential.add", input);
    },
    async disableCredential(credentialId, expectedVersion) {
      await command("router.credential.disable", { credentialId, expectedVersion });
    },
    async registerModel(input) {
      await command("router.model.register", input);
    },
    async configureRoute(input) {
      await command("router.route.configure", input);
    },
    async addRouteCandidate(input) {
      await command("router.candidate.add", input);
    },
    async configureSubscriptionPolicy(input) {
      await command("subscription.policy.configure", input);
    },

    async searchRegistry(queryText, limit = 20) {
      return safeView(await query("registry.search", { query: queryText, limit }));
    },
    async loadRegistryInfo(versionId) {
      return safeView(await query("registry.info", { versionId }));
    },
    async loadCapabilities() {
      const [extensions, inventory] = await Promise.all([
        client.query("extension.list", {}),
        query("registry.inventory", {}),
      ]);
      return { extensions: extensions.map(projectExtension), inventory: safeView(inventory) };
    },
    async loadExtensions() {
      const [extensions, inventory] = await Promise.all([
        client.query("extension.list", {}),
        query("registry.inventory", {}),
      ]);
      /*
       * 설치된 확장은 contributions·permissions가 비어서 나옵니다. 계약이 주지 않기 때문이고,
       * 지어내면 안 되므로 그대로 둡니다. 화면이 "무엇이 늘었는지 알 수 없다"고 말합니다.
       * registry.info는 manifest를 주지만 마켓플레이스 항목에만 있고, 선택할 때 채워집니다.
       */
      return projectExtensionEntries(extensions.map(projectExtension), safeView(inventory));
    },
    async loadGrowth() {
      const [configuration, memories, suggestions, effects] = await Promise.all([
        query("growth.configuration.get", {}),
        client.query("growth.memories", {}),
        query("growth.suggestions", { limit: 50 }),
        query("growth.effects", { limit: 50 }),
      ]);
      return {
        ...(configuration === undefined
          ? {}
          : { configuration: safeView(configuration) as NonNullable<GrowthView["configuration"]> }),
        memories,
        suggestions: safeView(suggestions) as GrowthView["suggestions"],
        effects: safeView(effects) as GrowthView["effects"],
      };
    },
    async configureGrowth(input) {
      await client.command("growth.configure", {
        subject: { type: "organization" },
        reflectionEnabled: input.reflectionEnabled,
        adoptionMode: input.adoptionMode,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      });
    },
    async rejectGrowthSuggestion(input) {
      await client.command("growth.suggestion.reject", {
        suggestionId: input.suggestionId,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
    },
    async approveGrowthSuggestion(input) {
      await client.command("growth.suggestion.approve", {
        suggestionId: input.suggestionId,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
    },
    async putExplicitMemory(input) {
      await client.command(
        "growth.memory.put",
        { key: input.key, kind: input.kind, value: input.value },
        { expectedRevision: input.revision },
      );
    },
    async forgetExplicitMemory(input) {
      await client.command("growth.memory.forget", { key: input.key }, { expectedRevision: input.revision });
    },
    async installRegistry(input, identity) {
      const result = await command("registry.install", input, identity);
      const data = object(result.data);
      const approvalId = typeof data?.approvalId === "string" ? data.approvalId : undefined;
      const installationId = typeof data?.installationId === "string" ? data.installationId : undefined;
      return {
        outcome: typeof result.outcome === "string" ? result.outcome : "unknown",
        ...(installationId === undefined ? {} : { installationId }),
        ...(approvalId === undefined ? {} : { approvalId }),
      };
    },

    async submitDirective(work, content, mode) {
      const run = requireRun(work);
      await client.command(
        "work.directive.submit",
        { workId: work.id, runId: run.runId, content, mode },
        { expectedRevision: work.revision },
      );
    },

    async decideApproval(approval, vote, reason) {
      if (approval.revision === undefined) throw new Error("승인 revision이 없어 결정을 제출할 수 없습니다");
      await client.command("approval.decide", {
        approvalId: approval.id,
        expectedApprovalRevision: approval.revision,
        vote,
        reason,
      });
      if (vote === "approve" && approval.action === "emergency.stop.disable") {
        await client.command("governance.emergency.release", {
          approvalId: approval.id,
          reason: "수신함 승인으로 긴급 정지 해제",
        });
      }
    },

    async cancelRun(work) {
      await client.command("run.cancel", { runId: requireRun(work).runId });
    },

    async resumeRun(work) {
      const run = requireRun(work);
      await client.command("run.resume", {
        runId: run.runId,
        retryBlocked: true,
      });
    },

    async startWork(input) {
      const result = await client.command("run.start", {
        request: {
          text: input.text,
          surface: "desktop",
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.workspacePaths === undefined ? {} : { workspacePaths: input.workspacePaths }),
        },
      });
      const runId = object(result.data)?.runId;
      if (typeof runId !== "string" || runId.length === 0) throw new Error("run.start 응답에 runId가 없습니다");
      return { runId };
    },

    async subscribeDurable(handler, after) {
      return await native.startStream("events", after === undefined ? {} : { after }, handler);
    },

    async subscribeExecution(executionId, handler) {
      return await native.startStream("executions", { executionId }, handler);
    },
  };
}

/**
 * 완성본 기준 설정. 조회가 실제로 돌려주는 모양 그대로 두고, 투영이 화면 뷰로 옮깁니다.
 * 계약이 타입을 주지 않으므로 여기서도 형태로만 고정합니다.
 */
const fixtureSettings: SettingsView = {
  catalog: {
    providers: [
      { providerId: "zai", displayName: "Z.ai", adapterKind: "openai-compatible", enabled: true },
      { providerId: "ollama", displayName: "Ollama", adapterKind: "ollama", enabled: true },
    ],
    endpoints: [
      {
        endpointId: "endpoint-zai",
        providerId: "zai",
        name: "coding-plan",
        baseUrl: "https://api.z.ai/v1",
        local: false,
      },
      {
        endpointId: "endpoint-ollama",
        providerId: "ollama",
        name: "local",
        baseUrl: "http://127.0.0.1:11434",
        local: true,
      },
    ],
    models: [
      {
        modelProfileId: "profile-glm",
        providerId: "zai",
        endpointId: "endpoint-zai",
        modelId: "glm-5.2",
        routeKind: "reasoning",
        verified: true,
        enabled: true,
      },
      {
        modelProfileId: "profile-qwen",
        providerId: "ollama",
        endpointId: "endpoint-ollama",
        modelId: "qwen3:8b",
        routeKind: "utility",
        verified: false,
        enabled: true,
      },
    ],
    candidates: [
      {
        candidateId: "candidate-1",
        routeId: "route-reasoning",
        modelProfileId: "profile-glm",
        priority: 0,
        enabled: true,
      },
      {
        candidateId: "candidate-2",
        routeId: "route-utility",
        modelProfileId: "profile-qwen",
        priority: 0,
        enabled: true,
      },
      {
        candidateId: "candidate-3",
        routeId: "route-embedding",
        modelProfileId: "profile-qwen",
        priority: 1,
        enabled: false,
      },
    ],
  },
  credentials: [{ credentialId: "credential-zai", providerId: "zai", label: "coding-plan", credentialType: "api_key" }],
  routes: [
    {
      routeId: "route-reasoning",
      name: "추론",
      routeKind: "reasoning",
      credentialPolicy: "required",
      dataPolicy: "cloud",
      equivalenceGroup: "reasoning",
      spentMicros: 482_000,
      totalBudgetMicros: 2_000_000,
      enabled: true,
    },
    {
      routeId: "route-utility",
      name: "보조 작업",
      routeKind: "utility",
      credentialPolicy: "optional",
      dataPolicy: "local",
      equivalenceGroup: "utility",
      spentMicros: 0,
      totalBudgetMicros: 500_000,
      enabled: true,
    },
    {
      routeId: "route-embedding",
      name: "임베딩",
      routeKind: "embedding",
      credentialPolicy: "optional",
      dataPolicy: "local",
      equivalenceGroup: "embedding",
      spentMicros: 0,
      totalBudgetMicros: 0,
      enabled: false,
    },
  ],
  providers: [{ providerId: "zai-coding-plan", displayName: "Z.ai Coding Plan", billingKind: "coding-plan" }],
  accounts: [
    {
      accountId: "account-zai",
      providerId: "zai-coding-plan",
      alias: "Z.ai GLM-5.2",
      scope: "organization",
      status: "active",
      billingKind: "coding-plan",
      version: 3,
      minimumRemainingRatio: 0.62,
      quotaExhausted: false,
      earliestResetAt: "2026-07-24T00:00:00.000Z",
    },
  ],
  quota: [],
  policy: [],
};

/**
 * 완성본 기준 확장 목록. 설치된 것 하나가 조직에 실제로 무엇을 더했는지 보여줍니다.
 * 실 daemon 경로는 계약이 manifest를 주지 않아 contributions·permissions가 비어서 옵니다.
 */
const fixtureExtensionEntries: readonly ExtensionEntryView[] = [
  {
    id: "installation-github",
    packageName: "@massion-ext/github",
    version: "1.2.0",
    description: "GitHub Issue·Pull Request·Check를 업무와 산출물에 연결합니다.",
    provenance: "official",
    installed: true,
    state: "healthy",
    contributions: [
      { kind: "runtimeTools", items: ["github.issue.read", "github.pull-request.open", "github.check.read"] },
      { kind: "organizationTemplates", items: ["release-engineering"] },
      { kind: "skills", items: ["pull-request-review", "release-notes"] },
      { kind: "surfaceConnectors", items: ["github"] },
      { kind: "eventConsumers", items: ["github-webhook"] },
    ],
    permissions: [
      { kind: "network", items: ["api.github.com"] },
      { kind: "secrets", items: ["github-token"] },
      { kind: "events", items: ["work.completed", "artifact.published"] },
      { kind: "storage", items: [""] },
    ],
  },
];

const fixtureRegistryInventory = [
  {
    versionId: "registry-slack-1.0.0",
    packageName: "@massion-ext/slack",
    packageVersion: "1.0.0",
    description: "Slack 요청, 진행 알림, 제한된 승인과 결과 Surface",
    visibility: "public",
    ownerOrganizationId: "massion-official",
    provenance: "official",
  },
  {
    versionId: "registry-github-1.0.0",
    packageName: "@massion-ext/github",
    packageVersion: "1.0.0",
    description: "GitHub Issue, Pull Request, Check, Review, Records와 Release 통합",
    visibility: "public",
    ownerOrganizationId: "massion-official",
    provenance: "official",
  },
  {
    versionId: "registry-discord-1.0.0",
    packageName: "@massion-ext/discord",
    packageVersion: "1.0.0",
    description: "Discord 요청, 진행 알림, 제한된 승인과 결과 Surface",
    visibility: "public",
    ownerOrganizationId: "massion-official",
    provenance: "official",
  },
] as const;

function fixtureRegistryDetail(versionId: string): unknown {
  const item = fixtureRegistryInventory.find((candidate) => candidate.versionId === versionId);
  if (!item) return {};
  const connector = item.packageName.endsWith("github")
    ? "github"
    : item.packageName.endsWith("discord")
      ? "discord"
      : "slack";
  return {
    version: {
      packageVersion: item.packageVersion,
      visibility: item.visibility,
      ownerOrganizationId: item.ownerOrganizationId,
      assessment: { provenance: item.provenance },
      manifest: {
        name: item.packageName,
        description: item.description,
        permissions: { network: [connector], secrets: [connector] },
        contributions: {
          surfaceConnectors: [{ id: connector }],
          eventConsumers: [{ id: `${connector}-notification` }],
        },
      },
    },
  };
}

const fixturePromise = <T>(run: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(run());
  });

export function createFixtureDesktopService(): DesktopService {
  const initialSnapshot = fixtureDataAdapter();
  const stop: DesktopStreamStop = () => {
    return fixturePromise(() => undefined);
  };

  return {
    initialSnapshot,
    bootstrap: () => fixturePromise(() => "ready"),
    loadIndex: (input) =>
      fixturePromise(() => {
        const { filter, search } = input;
        const normalizedSearch = search.trim().toLocaleLowerCase("ko");
        return initialSnapshot.works.filter(
          (work) =>
            workStatusFilter(work.status) === filter &&
            (normalizedSearch.length === 0 || work.title.toLocaleLowerCase("ko").includes(normalizedSearch)),
        );
      }),
    loadWork: (workId) =>
      fixturePromise(() => {
        const work = initialSnapshot.works.find((candidate) => candidate.id === workId);
        if (!work) throw new Error("Fixture Work를 찾을 수 없습니다");
        return work;
      }),
    loadWorkKnowledge: (workId) => fixturePromise(() => fixtureKnowledge(workId)),
    loadPendingApprovals: () =>
      fixturePromise(() =>
        initialSnapshot.works.flatMap((work) => work.approvals.filter((approval) => approval.status === "pending")),
      ),
    loadWorkspaces: () =>
      fixturePromise(() => [
        {
          workspaceId: "workspace-analytics",
          name: "analytics",
          path: "/Users/me/code/analytics",
          kind: "local-directory" as const,
          trust: "trusted" as const,
          status: "active" as const,
          revision: 3,
          createdAt: "2026-07-01T09:00:00.000Z",
          lastUsedAt: "2026-07-27T10:24:00.000Z",
        },
        {
          workspaceId: "workspace-ops",
          name: "ops-runbook",
          path: "/Users/me/code/ops-runbook",
          kind: "local-directory" as const,
          trust: "pending" as const,
          status: "active" as const,
          revision: 1,
          createdAt: "2026-07-20T09:00:00.000Z",
          lastUsedAt: "2026-07-20T09:00:00.000Z",
        },
      ]),
    loadKnowledgeIndex: (workspaceId) =>
      fixturePromise(() =>
        workspaceId === "workspace-analytics"
          ? {
              workspaceId,
              status: "ready" as const,
              indexVersionId: "index-2f9a10",
              fileCount: 214,
              symbolCount: 1_836,
              relationCount: 4_902,
              indexedAt: "2026-07-27T09:41:00.000Z",
              // 없는 것을 아는 것도 지식입니다. 왜 안 보이는지 여기서 답합니다.
              excluded: ["node_modules", "dist", ".git", "*.lock"],
            }
          : {
              workspaceId,
              status: "none" as const,
              fileCount: 0,
              symbolCount: 0,
              relationCount: 0,
              excluded: [],
            },
      ),
    loadKnowledgeGraph: (workspaceId, lens) =>
      fixturePromise(() =>
        workspaceId === "workspace-analytics" ? fixtureGraph(lens) : { lens, nodes: [], edges: [] },
      ),
    loadKnowledgeLinks: (workspaceId, nodeId) =>
      fixturePromise(() => (workspaceId === "workspace-analytics" ? fixtureLinks(nodeId) : [])),
    registerWorkspace: (path) =>
      fixturePromise(() => ({
        workspaceId: `workspace-${path}`,
        name: path.split("/").filter(Boolean).at(-1) ?? path,
        path,
        kind: "local-directory",
        trust: "pending",
        status: "active",
        revision: 0,
        createdAt: new Date(0).toISOString(),
        lastUsedAt: new Date(0).toISOString(),
      })),
    decideWorkspaceTrust: (workspace, decision) =>
      fixturePromise(() => ({ ...workspace, trust: decision, revision: workspace.revision + 1 })),
    // fixture 방은 model.ts의 활동을 그대로 씁니다. 실 daemon에서는 loadRoom이 대체합니다.
    loadRooms: (workId: string) =>
      fixturePromise(() => {
        const work = fixtureDataAdapter().works.find((candidate) => candidate.id === workId);
        if (!work) return [];
        const speak = (handle: string) =>
          speakerFor({ authorKind: "agent", authorId: handle }, fixtureOrganizationNodes);
        const quill = speak("evidence-research");
        const vega = speak("delivery-coordination");
        const budget = (
          roomId: string,
          name: string,
          rounds: number,
          maxRounds: number,
          tokens: number,
          maxTokens: number,
          cost: number,
          maxCost: number,
        ) =>
          projectRoomBudgets({
            workId,
            roomId,
            name,
            kind: "work",
            status: "active",
            participantIds: [],
            lastMessageSequence: 0,
            roundCount: rounds,
            maxRounds,
            usedTokens: tokens,
            maxTokens,
            usedCostMicros: cost,
            maxCostMicros: maxCost,
          });

        // 아직 아무도 말하지 않은 Work. 빈 방도 정상 상태입니다.
        if (work.activities.length === 0) {
          return [
            {
              roomId: `${workId}-core-office`,
              name: "Core Office",
              status: "active",
              participants: [speak("representative")],
              lastMessageSequence: 0,
              budgets: budget(`${workId}-core-office`, "Core Office", 0, 100, 0, 200_000, 0, 1_000_000),
              sharedContexts: [],
              activities: [],
            },
          ];
        }

        return withRoomReferences([
          {
            roomId: `${workId}-core-office`,
            name: "Core Office",
            status: "active",
            participants: [speak("representative"), speak("context-strategy"), quill, vega, speak("assurance")],
            lastMessageSequence: work.activities.length,
            budgets: budget(`${workId}-core-office`, "Core Office", 6, 100, 48_200, 200_000, 310_000, 1_000_000),
            sharedContexts: [
              { id: "ref-brief", label: "evidence-brief · 라벨링 기준 브리프", checksum: "a3f1c8" },
              { id: "ref-log", label: "evidence-brief · 해지 로그 90일", checksum: "7c02b1" },
            ],
            activities: work.activities,
          },
          // 에이전트 둘이 대표를 거치지 않고 직접 붙은 방. 도메인은 참가자 수만 다른 같은 협업방입니다.
          {
            roomId: `${workId}-cohort`,
            name: "코호트 정의 정리",
            status: "active",
            participants: [quill, vega],
            lastMessageSequence: 3,
            budgets: budget(`${workId}-cohort`, "코호트 정의 정리", 2, 6, 9_400, 60_000, 61_000, 500_000),
            sharedContexts: [{ id: "ref-cohort", label: "evidence-brief · 2분기 코호트 정의", checksum: "5be07d" }],
            activities: [
              {
                id: "cohort-q",
                kind: "room",
                messageType: "question",
                time: "10:26",
                speaker: vega,
                recipient: quill.name,
                content: "2분기 코호트 정의를 3분기에 맞추려면 어떤 필드를 다시 계산해야 하나요?",
              },
              {
                id: "cohort-a",
                kind: "room",
                messageType: "answer",
                time: "10:27",
                speaker: quill,
                indented: true,
                content: "가입 기준일과 해지 판정 유예 기간 둘입니다. 나머지는 그대로 씁니다.",
                evidence: { label: "2분기 코호트 정의", checksum: "5be07d" },
              },
              {
                id: "cohort-c",
                kind: "room",
                messageType: "change_request",
                time: "10:28",
                speaker: vega,
                target: "코호트 데이터.csv",
                content: "유예 기간을 14일로 통일해서 다시 뽑아 주세요.",
              },
            ],
          },
        ]);
      }),

    loadOrganization: () => fixturePromise(() => ({ version: 1, nodes: fixtureOrganizationNodes })),
    loadAutonomy: () =>
      fixturePromise(() => ({
        mode: "automatic",
        revision: 0,
        runtimePermissionStatus: "governed",
        emergencyStopActive: false,
      })),
    setAutonomy: (mode, expectedRevision) =>
      fixturePromise(() => ({
        mode,
        revision: expectedRevision + 1,
        runtimePermissionStatus: mode === "full-access" ? "full-access" : "governed",
        emergencyStopActive: false,
      })),
    loadEmergency: () => fixturePromise(() => ({ active: false, revision: 0 })),
    activateEmergency: (reason) => fixturePromise(() => ({ active: true, reason, revision: 1 })),
    releaseEmergency: (_approvalId, reason) => fixturePromise(() => ({ active: false, reason, revision: 2 })),
    loadExtensions: () =>
      fixturePromise(() => [
        ...fixtureExtensionEntries,
        ...marketplaceEntries(
          fixtureRegistryInventory,
          fixtureExtensionEntries.map((item) => item.packageName),
        ),
      ]),
    loadSettings: () => fixturePromise(() => fixtureSettings),
    connectZaiCodingPlan: () => fixturePromise(() => undefined),
    registerProvider: () => fixturePromise(() => undefined),
    registerEndpoint: () => fixturePromise(() => undefined),
    addCredential: () => fixturePromise(() => undefined),
    disableCredential: () => fixturePromise(() => undefined),
    registerModel: () => fixturePromise(() => undefined),
    configureRoute: () => fixturePromise(() => undefined),
    addRouteCandidate: () => fixturePromise(() => undefined),
    configureSubscriptionPolicy: () => fixturePromise(() => undefined),
    searchRegistry: (query, limit = 20) =>
      fixturePromise(() =>
        fixtureRegistryInventory
          .filter((item) =>
            `${item.packageName} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()),
          )
          .slice(0, limit),
      ),
    loadRegistryInfo: (versionId) => fixturePromise(() => fixtureRegistryDetail(versionId)),
    loadCapabilities: () => fixturePromise(() => ({ extensions: [], inventory: fixtureRegistryInventory })),
    configureGrowth: () => fixturePromise(() => undefined),
    putExplicitMemory: () => fixturePromise(() => undefined),
    forgetExplicitMemory: () => fixturePromise(() => undefined),
    loadGrowth: () =>
      fixturePromise(() => ({
        configuration: {
          reflectionEnabled: true,
          adoptionMode: "review" as const,
          governanceDecisionId: "decision-growth-0007",
          activatedAt: "2026-07-21T09:12:00.000Z",
        },
        suggestions: [
          {
            suggestionId: "suggestion-cohort-guard",
            workId: "churn-q3",
            targetKind: "prompt",
            operation: "replace-instruction",
            summary: "분기 비교 요청에서 코호트 정의를 먼저 확인하게 합니다.",
            revision: 3,
            createdAt: "2026-07-23T10:31:00.000Z",
            reflectionRunId: "reflection-0011",
            sourceReferenceIds: ["work:churn-q3", "message:cohort-challenge", "verification:significance"],
            patch: [
              {
                targetHandle: "context-strategy",
                path: "완료 기준",
                before: "분석 대상 기간과 지표를 명시한다",
                after: "분석 대상 기간과 지표를 명시하고, 기간 간 비교가 포함되면 코호트 정의 일치를 먼저 확인한다",
              },
            ],
            evaluation: {
              evaluationRunId: "evaluation-0031",
              outcome: "eligible" as const,
              strategyVersionId: "strategy-v4",
              signals: [
                {
                  signalId: "signal-rework",
                  group: "required" as const,
                  origin: "deterministic" as const,
                  outcome: "passed" as const,
                  score: 0.75,
                  adapterId: "rework-counter",
                  adapterVersion: "1.2.0",
                  note: "최근 12개 Work 중 3건이 같은 원인으로 재작업",
                },
                {
                  signalId: "signal-assurance",
                  group: "required" as const,
                  origin: "independent" as const,
                  outcome: "passed" as const,
                  score: 0.68,
                  adapterId: "assurance-verdict",
                  adapterVersion: "2.0.1",
                  note: "독립 검증이 같은 원인을 2회 반론으로 제기",
                },
                {
                  signalId: "signal-latency",
                  group: "conflict" as const,
                  origin: "deterministic" as const,
                  outcome: "failed" as const,
                  score: 0.31,
                  adapterId: "stage-duration",
                  adapterVersion: "1.0.4",
                  note: "맥락 단계 소요가 중앙값 기준 18% 늘어남",
                },
                {
                  signalId: "signal-selfcheck",
                  group: "supporting" as const,
                  origin: "model-self" as const,
                  outcome: "passed" as const,
                  score: 0.82,
                  adapterId: "reflection-selfcheck",
                  adapterVersion: "0.9.0",
                  note: "모델 자기평가. 독립 신호로 계산하지 않음",
                },
              ],
            },
            targetDrifted: false,
            rationale:
              "3분기 이탈 분석에서 검증이 코호트 정의 불일치를 반론으로 제기했고, 같은 원인으로 이전 두 Work에서도 재작업이 있었습니다.",
            expectedEffect: "분기 비교가 포함된 Work의 재작업이 줄어듭니다.",
            riskSummary: "완료 기준이 하나 늘어 단순 요청의 맥락 단계가 길어질 수 있습니다.",
            status: "awaiting-review",
          },
          {
            suggestionId: "suggestion-quant-persist",
            workId: "churn-q3",
            targetKind: "organization",
            operation: "promote-node",
            summary: "임시로 만든 계량분석 팀을 조직에 남깁니다.",
            revision: 1,
            createdAt: "2026-07-23T10:44:00.000Z",
            reflectionRunId: "reflection-0011",
            sourceReferenceIds: ["work:churn-q3", "organization:version-13"],
            patch: [
              {
                path: "계량분석 팀",
                before: 'scope: "work" · 이 Work가 끝나면 사라짐',
                after: 'scope: "persistent" · 조직에 남음',
              },
            ],
            evaluation: {
              evaluationRunId: "evaluation-0032",
              outcome: "ineligible" as const,
              strategyVersionId: "strategy-v4",
              signals: [
                {
                  signalId: "signal-demand",
                  group: "required" as const,
                  origin: "deterministic" as const,
                  outcome: "passed" as const,
                  score: 0.71,
                  adapterId: "capability-demand",
                  adapterVersion: "1.1.0",
                  note: "최근 4개 Work 중 3개가 통계 검정을 요구",
                },
                {
                  signalId: "signal-sample",
                  group: "required" as const,
                  origin: "deterministic" as const,
                  outcome: "failed" as const,
                  score: 0.22,
                  adapterId: "observation-window",
                  adapterVersion: "1.0.0",
                  note: "관측 표본 4건. 최소 표본 10건에 못 미침",
                },
              ],
            },
            targetDrifted: true,
            rationale: "최근 4개 Work 중 3개가 통계 검정을 요구했고 매번 scope work 노드를 새로 만들었습니다.",
            expectedEffect: "같은 팀을 반복 생성하지 않고 조직 버전이 안정됩니다.",
            riskSummary: "쓰이지 않는 분기에도 노드가 남아 조직이 커집니다.",
            status: "awaiting-review",
          },
        ],
        memories: [
          {
            memoryVersionId: "memory-0004",
            revision: 4,
            entries: [
              {
                key: "answer-style",
                kind: "preference" as const,
                value: "분석 결과는 결론부터 설명한다",
                authority: "explicit" as const,
              },
            ],
          },
        ],
        effects: [
          {
            effectEvaluationId: "effect-0002",
            adoptionId: "adoption-0002",
            result: "improved" as const,
            suggestionId: "suggestion-handoff-note",
            measure: {
              score: 0.34,
              observationCount: 14,
              minimumObservations: 10,
              unit: "재작업 비율",
              direction: "lower" as const,
              baseline: 0.51,
            },
          },
        ],
      })),
    approveGrowthSuggestion: () => fixturePromise(() => undefined),
    rejectGrowthSuggestion: () => fixturePromise(() => undefined),
    installRegistry: () =>
      fixturePromise(() => ({ outcome: "succeeded", installationId: "installation-fixture-0001" })),
    submitDirective: () => fixturePromise(() => undefined),
    decideApproval: () => fixturePromise(() => undefined),
    cancelRun: () => fixturePromise(() => undefined),
    resumeRun: () => fixturePromise(() => undefined),
    startWork: () => fixturePromise(() => ({ runId: "run-fixture-0001" })),
    subscribeDurable: () => fixturePromise(() => stop),
    subscribeExecution: () => fixturePromise(() => stop),
  };
}

function safeView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeView);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      /(?:secret|token|password|api[-_]?key)/i.test(key) ? [] : [[key, safeView(child)]],
    ),
  );
}

function workspaceView(value: unknown): DesktopWorkspaceView {
  const workspace = object(value);
  if (
    typeof workspace?.workspaceId !== "string" ||
    typeof workspace.name !== "string" ||
    typeof workspace.path !== "string" ||
    workspace.kind !== "local-directory" ||
    (workspace.trust !== "pending" && workspace.trust !== "trusted" && workspace.trust !== "blocked") ||
    (workspace.status !== "active" && workspace.status !== "archived") ||
    typeof workspace.revision !== "number" ||
    typeof workspace.createdAt !== "string" ||
    typeof workspace.lastUsedAt !== "string"
  )
    throw new Error("Workspace 응답이 유효하지 않습니다");
  return workspace as unknown as DesktopWorkspaceView;
}

function projectOrganization(snapshot: Partial<OrganizationGraphSnapshotV1>): OrganizationView {
  return {
    ...(snapshot.version === undefined ? {} : { version: snapshot.version.version }),
    nodes: (snapshot.nodes ?? []).map((node) => ({
      id: node.node_id,
      handle: node.handle,
      name: node.name,
      responsibility: node.responsibility,
      ...(node.parent_handle === undefined ? {} : { parentHandle: node.parent_handle }),
      status: node.status,
      role: node.role,
      capabilities: node.capabilities,
      scope: node.scope,
      ...(node.work_id === undefined ? {} : { workId: node.work_id }),
    })),
  };
}

// ── 협업방 투영 ────────────────────────────────────────────────────
//
// 도메인이 실제로 가진 것만 옮깁니다. 없는 것은 지어내지 않습니다.
//   있음: messageType · authorId(handle) · content · createdAt · replyTo · causedBy · sequence
//   없음: question의 수신자, handoff의 받는 쪽. 둘 다 구조화돼 있지 않습니다.

/** 조직 노드에서 역할 배지 문구를 찾습니다. 없으면 handle을 그대로 씁니다. */
function roleLabelFor(handle: string, nodes: readonly OrganizationNodeView[]): string {
  const node = nodes.find((candidate) => candidate.handle === handle);
  if (!node) return handle;
  return node.responsibility.split(",")[0]?.trim() || node.name;
}

function speakerFor(
  message: Pick<RoomMessageViewV1, "authorKind" | "authorId">,
  nodes: readonly OrganizationNodeView[],
): SpeakerView {
  if (message.authorKind !== "agent") {
    return { handle: message.authorId, name: "나", initial: "나", accentSlot: -1, role: "사람", human: true };
  }
  const role = roleLabelFor(message.authorId, nodes);
  const identity = agentIdentityToken(message.authorId, role);
  const node = nodes.find((candidate) => candidate.handle === message.authorId);
  return {
    handle: identity.handle,
    name: identity.name,
    initial: identity.initial,
    accentSlot: identity.accentSlot,
    role,
    // 조직 그래프에 없는 handle이 말하고 있으면 아직 승인되지 않았거나 scope:"work" 노드입니다.
    ...(node ? {} : { provisional: true }),
  };
}

function clockOf(createdAt: string): string {
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? createdAt : parsed.toTimeString().slice(0, 5);
}

/** fixture 조직. Core Office 일부만 둡니다. 실 daemon에서는 organization.graph.snapshot이 대체합니다. */
/**
 * Core Office 8팀. `packages/organization/src/organization.ts`의 내장 노드와 같은 집합이며
 * `parentHandle`이 있어야 화면이 계층으로 그립니다. 이전에는 다섯 개였고 부모가 없어
 * 조직도가 평평했습니다 — 조직 화면인데 누가 누구 아래인지 보이지 않았습니다.
 *
 * name은 도메인 노드 이름 그대로 둡니다. 화면에 나오는 이름은 agentIdentityToken이 소유합니다.
 */
const fixtureOrganizationNodes: OrganizationNodeView[] = [
  {
    id: "representative",
    handle: "representative",
    name: "Representative",
    responsibility: "사용자 요청 접수, 조정, 최종 응답",
    status: "active",
    role: "orchestrator",
    capabilities: ["request-coordination"],
    scope: "persistent",
  },
  {
    id: "context-strategy",
    handle: "context-strategy",
    name: "Context & Strategy",
    parentHandle: "representative",
    responsibility: "맥락 구성, 계획, 위험 분석",
    status: "active",
    role: "operator",
    capabilities: ["context-strategy"],
    scope: "persistent",
  },
  {
    id: "evidence-research",
    handle: "evidence-research",
    name: "Evidence & Research",
    parentHandle: "representative",
    responsibility: "근거 조사, 출처 검증",
    status: "active",
    role: "operator",
    capabilities: ["evidence-research"],
    scope: "persistent",
  },
  {
    id: "governance",
    handle: "governance",
    name: "Governance",
    parentHandle: "representative",
    responsibility: "실행·조직·Extension·자기수정 정책과 승인",
    status: "active",
    role: "operator",
    capabilities: ["governance"],
    scope: "persistent",
  },
  {
    id: "delivery-coordination",
    handle: "delivery-coordination",
    name: "Delivery Coordination",
    parentHandle: "representative",
    responsibility: "Task 배정, 전문 팀 실행 조정, 결과 통합",
    status: "active",
    role: "coordinator",
    capabilities: ["delivery-coordination"],
    scope: "persistent",
  },
  {
    id: "assurance",
    handle: "assurance",
    name: "Assurance",
    parentHandle: "representative",
    responsibility: "독립 리뷰, 테스트·보안·운영 검증",
    status: "active",
    role: "operator",
    capabilities: ["assurance"],
    scope: "persistent",
  },
  {
    id: "records-documentation",
    handle: "records-documentation",
    name: "Records & Documentation",
    parentHandle: "representative",
    responsibility: "handoff·결정·계보 기록, 문서 영향 반영",
    status: "active",
    role: "operator",
    capabilities: ["records-documentation"],
    scope: "persistent",
  },
  {
    id: "growth",
    handle: "growth",
    name: "Growth",
    parentHandle: "representative",
    responsibility: "Reflection, 개선안 평가·채택·효과 비교·되돌리기",
    status: "active",
    role: "operator",
    capabilities: ["growth"],
    scope: "persistent",
  },
  // scope:"work"로 편성된 임시 팀. 승인되면 조직에 잠시 존재하고 업무가 끝나면 사라집니다.
  {
    id: "quant-analysis",
    handle: "quant-analysis",
    name: "계량분석 팀",
    parentHandle: "delivery-coordination",
    responsibility: "코호트 정규화, 유의성 검정, 시계열 분해",
    status: "active",
    role: "operator",
    capabilities: ["quant-analysis"],
    scope: "work",
  },
  // Software Engineering 프로필(persistent). 설치 함수는 있으나 생산 Bootstrap 호출이 없어(헌법 9.2)
  // 실 조직은 Core Office 8로 평평합니다. 완성본 기준으로 편성된 조직의 실제 깊이를 보이려 넣습니다.
  {
    id: "software-engineering",
    handle: "software-engineering",
    name: "Software Engineering",
    parentHandle: "delivery-coordination",
    responsibility: "개발 Task 분해, 전문 역할 조정과 변경 통합",
    status: "active",
    role: "coordinator",
    capabilities: ["software-delivery"],
    scope: "persistent",
  },
  {
    id: "se-lead",
    handle: "software-engineering.engineering-lead",
    name: "Engineering Lead",
    parentHandle: "software-engineering",
    responsibility: "개발 Task 분해, 경로 충돌 조정과 기술 통합 판정",
    status: "active",
    role: "coordinator",
    capabilities: ["engineering-lead"],
    scope: "persistent",
  },
  {
    id: "se-fe",
    handle: "software-engineering.frontend-specialist",
    name: "Frontend Specialist",
    parentHandle: "software-engineering",
    responsibility: "Web 인터페이스와 클라이언트 동작 구현",
    status: "active",
    role: "operator",
    capabilities: ["frontend-engineering"],
    scope: "persistent",
  },
  {
    id: "se-be",
    handle: "software-engineering.backend-specialist",
    name: "Backend Specialist",
    parentHandle: "software-engineering",
    responsibility: "서비스, API와 서버 애플리케이션 구현",
    status: "active",
    role: "operator",
    capabilities: ["backend-engineering"],
    scope: "persistent",
  },
  {
    id: "se-db",
    handle: "software-engineering.database-specialist",
    name: "Database Specialist",
    parentHandle: "software-engineering",
    responsibility: "데이터 모델, 질의와 마이그레이션 구현",
    status: "active",
    role: "operator",
    capabilities: ["database-engineering"],
    scope: "persistent",
  },
  {
    id: "se-test",
    handle: "software-engineering.test-engineer",
    name: "Test Engineer",
    parentHandle: "software-engineering",
    responsibility: "실패 재현 테스트와 검증 시나리오 구현",
    status: "active",
    role: "operator",
    capabilities: ["test-engineering"],
    scope: "persistent",
  },
  {
    id: "se-sec",
    handle: "software-engineering.security-reviewer",
    name: "Security Reviewer",
    parentHandle: "software-engineering",
    responsibility: "코드 변경의 위협·권한·비밀정보 노출 검토",
    status: "active",
    role: "operator",
    capabilities: ["secure-coding-review"],
    scope: "persistent",
  },
];

export function projectRoomActivities(
  messages: readonly RoomMessageViewV1[],
  nodes: readonly OrganizationNodeView[],
): ActivityView[] {
  const ordered = [...messages].sort((left, right) => left.sequence - right.sequence);
  const byId = new Map(ordered.map((message) => [message.messageId, message]));

  return ordered.map((message, index): ActivityView => {
    const speaker = speakerFor(message, nodes);
    const time = clockOf(message.createdAt);

    if (message.messageType === "status") {
      return { id: message.messageId, kind: "roomStatus", time, content: message.content };
    }

    if (message.messageType === "handoff") {
      // ponytail: 받는 쪽은 도메인에 없습니다. 다음 발언자를 받는 쪽으로 읽되,
      // 다음 발언이 없거나 같은 화자면 한쪽만 그립니다. 도메인이 대상을 실으면 그때 교체합니다.
      const next = ordered[index + 1];
      const receiver = next && next.authorId !== message.authorId ? speakerFor(next, nodes) : undefined;
      return { id: message.messageId, kind: "handoff", time, from: speaker, ...(receiver ? { to: receiver } : {}) };
    }

    const origin = message.replyToMessageId === undefined ? undefined : byId.get(message.replyToMessageId);

    return {
      id: message.messageId,
      kind: "room",
      time,
      messageType: message.messageType === "proposal" ? "decision" : (message.messageType as "question"),
      speaker,
      content: message.content,
      // 답변은 질문 아래 들여써서 짝을 눈에 보이게 합니다.
      ...(message.messageType === "answer" && origin ? { indented: true } : {}),
      // 반론은 무엇에 대한 반론인지 없이 존재할 수 없습니다.
      ...(message.messageType === "challenge" && origin
        ? {
            quoted: {
              author: speakerFor(origin, nodes).name,
              time: clockOf(origin.createdAt),
              content: origin.content,
            },
          }
        : {}),
    };
  });
}

/** 한도가 없는 항목은 목록에 넣지 않습니다. 0/0 막대는 정보가 아니라 소음입니다. */
export function projectRoomBudgets(room: RoomViewV1): RoomBudgetView[] {
  const budgets: RoomBudgetView[] = [];
  if (room.maxRounds !== undefined) {
    const used = room.roundCount ?? 0;
    budgets.push({
      label: "라운드",
      used,
      limit: room.maxRounds,
      display: `${String(used)} / ${String(room.maxRounds)}`,
    });
  }
  if (room.maxTokens !== undefined) {
    const used = room.usedTokens ?? 0;
    budgets.push({
      label: "토큰",
      used,
      limit: room.maxTokens,
      display: `${compactCount(used)} / ${compactCount(room.maxTokens)}`,
    });
  }
  if (room.maxCostMicros !== undefined) {
    const used = room.usedCostMicros ?? 0;
    budgets.push({
      label: "비용",
      used,
      limit: room.maxCostMicros,
      display: `$${(used / 1_000_000).toFixed(2)} / $${(room.maxCostMicros / 1_000_000).toFixed(2)}`,
    });
  }
  return budgets;
}

function compactCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/**
 * 하위 방을 대표 방 타임라인에 인라인 참조로 끼워 넣습니다.
 * 위치는 그 방의 첫 발언 시각에서 파생합니다. 도메인에 부모-자식 관계가 없으므로 만들어내지 않습니다.
 */
export function withRoomReferences(rooms: readonly RoomView[]): RoomView[] {
  const [main, ...others] = rooms;
  if (!main || others.length === 0) return [...rooms];

  const references: ActivityView[] = others.map((room) => {
    const last = room.activities.at(-1);
    return {
      id: `roomref:${room.roomId}`,
      kind: "roomRef",
      time: room.activities[0]?.time ?? "",
      roomId: room.roomId,
      name: room.name,
      participants: room.participants,
      messageCount: room.activities.length,
      lastLine: last && "content" in last ? last.content : `${String(room.activities.length)}개의 발언`,
      waiting: room.activities.some((activity) => activity.kind === "proposal" || activity.kind === "approval"),
    };
  });

  const merged = [...main.activities, ...references].sort((left, right) => left.time.localeCompare(right.time));
  return [{ ...main, activities: merged }, ...others];
}

export function projectRoom(
  room: RoomViewV1,
  messages: readonly RoomMessageViewV1[],
  nodes: readonly OrganizationNodeView[],
  sharedContexts: readonly SharedContextViewV1[] = [],
): RoomView {
  return {
    roomId: room.roomId,
    name: room.name,
    status: room.status,
    participants: room.participantIds.map((handle) => speakerFor({ authorKind: "agent", authorId: handle }, nodes)),
    lastMessageSequence: room.lastMessageSequence,
    budgets: projectRoomBudgets(room),
    sharedContexts: sharedContexts
      .filter((reference) => reference.roomId === room.roomId)
      .map((reference) => ({
        id: reference.sharedContextReferenceId,
        label: `${reference.sourceKind} · ${reference.sourceId}`,
        checksum: reference.checksum.slice(0, 6),
      })),
    activities: projectRoomActivities(messages, nodes),
  };
}

function projectAutonomy(value: GovernanceAutonomyViewV1 | Record<string, unknown> | undefined): AutonomyView {
  if (
    !value ||
    (value.mode !== "automatic" && value.mode !== "review" && value.mode !== "full-access") ||
    typeof value.revision !== "number"
  )
    throw new Error("자율성 설정 응답이 유효하지 않습니다");
  const source = value as Record<string, unknown>;
  const runtimePermissionStatus =
    source.runtimePermissionStatus === "limited" || source.runtimePermissionStatus === "full-access"
      ? source.runtimePermissionStatus
      : value.mode === "full-access"
        ? "full-access"
        : "governed";
  return {
    mode: value.mode,
    revision: value.revision,
    runtimePermissionStatus,
    ...(typeof source.permissionLimitReason === "string"
      ? { permissionLimitReason: source.permissionLimitReason }
      : {}),
    emergencyStopActive: source.emergencyStopActive === true,
  };
}

function projectEmergency(value: unknown): EmergencyView {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  if (!source || typeof source.active !== "boolean" || !Number.isSafeInteger(source.revision)) {
    return { active: false, revision: 0 };
  }
  return {
    active: source.active,
    revision: source.revision as number,
    ...(typeof source.reason === "string" ? { reason: source.reason } : {}),
    ...(typeof source.approvalId === "string" ? { approvalId: source.approvalId } : {}),
  };
}

function projectExtension(extension: ExtensionInstallationViewV1): ExtensionView {
  return {
    id: extension.installationId,
    packageName: extension.packageName,
    status: extension.state,
    ...(extension.activeVersionId === undefined ? {} : { activeVersionId: extension.activeVersionId }),
    activationGeneration: extension.activationGeneration,
  };
}

function rows(value: unknown): readonly Record<string, unknown>[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : [];
  return source.flatMap((row) =>
    row && typeof row === "object" && !Array.isArray(row) ? [row as Record<string, unknown>] : [],
  );
}

const str = (row: Record<string, unknown>, key: string): string => (typeof row[key] === "string" ? row[key] : "");
const num = (row: Record<string, unknown>, key: string): number => (typeof row[key] === "number" ? row[key] : 0);
const bool = (row: Record<string, unknown>, key: string): boolean => row[key] === true;

export function projectModelRoutes(routes: unknown, catalog: unknown): readonly ModelRouteView[] {
  const source = catalog && typeof catalog === "object" ? (catalog as Record<string, unknown>) : {};
  const candidates = rows(source.candidates);
  const models = rows(source.models);
  const endpoints = rows(source.endpoints);
  return rows(routes)
    .filter((row) => typeof row.routeId === "string")
    .map((row) => {
      const mine = candidates
        .filter((candidate) => str(candidate, "routeId") === str(row, "routeId") && bool(candidate, "enabled"))
        .sort((left, right) => num(left, "priority") - num(right, "priority"));
      // 후보가 여럿이어도 실제로 먼저 불리는 것은 우선순위 0입니다. 화면은 그 하나를 말합니다.
      const primary = models.find((model) => str(model, "modelProfileId") === str(mine[0] ?? {}, "modelProfileId"));
      const endpoint = primary
        ? endpoints.find((item) => str(item, "endpointId") === str(primary, "endpointId"))
        : undefined;
      return {
        routeId: str(row, "routeId"),
        name: str(row, "name"),
        routeKind: str(row, "routeKind"),
        enabled: bool(row, "enabled"),
        spentMicros: num(row, "spentMicros"),
        totalBudgetMicros: num(row, "totalBudgetMicros"),
        candidateCount: mine.length,
        ...(primary === undefined ? {} : { primaryModelId: str(primary, "modelId") }),
        ...(primary === undefined ? {} : { primaryVerified: bool(primary, "verified") }),
        ...(endpoint === undefined ? {} : { primaryLocal: bool(endpoint, "local") }),
      };
    });
}

export function projectProviderConnections(catalog: unknown): readonly ProviderConnectionView[] {
  const source = catalog && typeof catalog === "object" ? (catalog as Record<string, unknown>) : {};
  const endpoints = rows(source.endpoints);
  return rows(source.providers)
    .filter((row) => typeof row.providerId === "string")
    .map((row) => ({
      providerId: str(row, "providerId"),
      displayName: str(row, "displayName"),
      adapterKind: str(row, "adapterKind"),
      enabled: bool(row, "enabled"),
      endpoints: endpoints
        .filter((endpoint) => str(endpoint, "providerId") === str(row, "providerId"))
        .map((endpoint) => ({
          name: str(endpoint, "name"),
          baseUrl: str(endpoint, "baseUrl"),
          local: bool(endpoint, "local"),
        })),
    }));
}

export function projectSubscriptionAccounts(accounts: unknown): readonly SubscriptionAccountView[] {
  // 식별자 없는 행은 계정이 아닙니다. 빈 값으로 채워 넣으면 없는 계정이 목록에 생깁니다.
  return rows(accounts)
    .filter((row) => typeof row.accountId === "string")
    .map((row) => ({
      accountId: str(row, "accountId"),
      providerId: str(row, "providerId"),
      alias: str(row, "alias"),
      status: str(row, "status"),
      billingKind: str(row, "billingKind"),
      ...(typeof row.quotaExhausted === "boolean" ? { quotaExhausted: row.quotaExhausted } : {}),
      ...(typeof row.minimumRemainingRatio === "number" ? { minimumRemainingRatio: row.minimumRemainingRatio } : {}),
      ...(typeof row.earliestResetAt === "string" ? { earliestResetAt: row.earliestResetAt } : {}),
      ...(typeof row.cooldownUntil === "string" ? { cooldownUntil: row.cooldownUntil } : {}),
    }));
}

const CONTRIBUTION_KINDS: readonly ContributionKind[] = [
  "runtimeTools",
  "organizationTemplates",
  "skills",
  "surfaceConnectors",
  "growthSignals",
  "growthTargets",
  "eventConsumers",
  "modelEvaluationBundles",
];

const PERMISSION_KINDS: readonly PermissionKind[] = [
  "tools",
  "network",
  "files",
  "secrets",
  "process",
  "mcp",
  "storage",
  "events",
];

/** manifest의 선언을 뷰로 옮깁니다. 선언되지 않은 종류는 줄 자체를 만들지 않습니다. */
export function projectManifestDeclarations(
  manifest: unknown,
): Pick<ExtensionEntryView, "contributions" | "permissions"> {
  const source =
    manifest && typeof manifest === "object" && !Array.isArray(manifest) ? (manifest as Record<string, unknown>) : {};
  const read = (group: unknown, key: string): readonly string[] => {
    const value =
      group && typeof group === "object" && !Array.isArray(group) ? (group as Record<string, unknown>)[key] : undefined;
    if (Array.isArray(value)) {
      return value.map((item) =>
        typeof item === "string"
          ? item
          : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : JSON.stringify(item),
      );
    }
    // storage처럼 배열이 아닌 선언은 존재 사실만 남깁니다. 원문을 그대로 흘리지 않습니다.
    return value && typeof value === "object" ? [""] : [];
  };
  return {
    contributions: CONTRIBUTION_KINDS.flatMap((kind) => {
      const items = read(source.contributions, kind);
      return items.length > 0 ? [{ kind, items }] : [];
    }),
    permissions: PERMISSION_KINDS.flatMap((kind) => {
      const items = read(source.permissions, kind);
      return items.length > 0 ? [{ kind, items }] : [];
    }),
  };
}

/** registry.inventory 응답을 뷰로 옮깁니다. 이미 설치된 패키지는 목록에서 뺍니다. */
export function marketplaceEntries(
  inventory: unknown,
  installedPackages: readonly string[],
): readonly ExtensionEntryView[] {
  const rows = Array.isArray(inventory)
    ? inventory
    : inventory && typeof inventory === "object" && Array.isArray((inventory as { items?: unknown }).items)
      ? (inventory as { items: unknown[] }).items
      : [];
  return rows
    .flatMap((row): ExtensionEntryView[] => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      if (typeof record.versionId !== "string" || typeof record.packageName !== "string") return [];
      if (installedPackages.includes(record.packageName)) return [];
      return [
        {
          id: record.versionId,
          packageName: record.packageName,
          version: typeof record.packageVersion === "string" ? record.packageVersion : "",
          description: typeof record.description === "string" ? record.description : "",
          provenance: typeof record.provenance === "string" ? record.provenance : "",
          installed: false,
          // manifest는 registry.info에만 있습니다. 선택할 때 채워집니다.
          ...projectManifestDeclarations(undefined),
        },
      ];
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
}

/**
 * 설치된 확장을 먼저, 마켓플레이스를 뒤에 둡니다. 헌법 6절의 "조직에 추가된 Capability를 먼저"는
 * 상세 안의 순서만이 아니라 목록의 순서이기도 합니다.
 */
export function projectExtensionEntries(
  installed: readonly ExtensionView[],
  inventory: unknown,
): readonly ExtensionEntryView[] {
  const entries = installed.map((item) => ({
    id: item.id,
    packageName: item.packageName,
    version: item.activeVersionId ?? "",
    description: "",
    provenance: "",
    installed: true,
    state: item.status,
    ...projectManifestDeclarations(undefined),
  }));
  return [
    ...entries,
    ...marketplaceEntries(
      inventory,
      entries.map((item) => item.packageName),
    ),
  ];
}

interface WorkDetailSources {
  readonly detail: WorkDetailV1;
  readonly runs: readonly RunViewV1[];
  readonly activities: readonly WorkActivityViewV1[];
  readonly tasks: readonly TaskViewV1[];
  readonly assignments: readonly AssignmentViewV1[];
  readonly executions: readonly ExecutionViewV1[];
  readonly artifacts: readonly ArtifactViewV1[];
  readonly verifications: readonly VerificationViewV1[];
  readonly approvals: readonly ApprovalViewV1[];
  readonly directives: readonly DirectiveViewV1[];
}

function projectWorkSummary(work: WorkSummaryV1): WorkView {
  const status = projectWorkStatus(work.status);
  return {
    id: work.workId,
    title: work.title,
    status,
    revision: work.revision,
    sourceStatus: work.status,
    team: work.workspaceId === undefined ? "Massion" : "워크스페이스",
    updatedAt: work.updatedAt ?? "",
    summary: work.title,
    progress: status === "complete" ? 100 : 0,
    approvals: [],
    tasks: [],
    agents: [],
    artifacts: [],
    verifications: [],
    activities: [],
  };
}

function projectWorkDetail(sources: WorkDetailSources): WorkView {
  const tasks = sources.tasks.map(projectTask);
  const agents = projectAgents(sources.assignments, sources.executions);
  const artifacts = sources.artifacts.map(projectArtifact);
  const approvals = sources.approvals.map(projectApproval);
  const run = sources.runs.find((candidate) => ACTIVE_RUN_STATUSES.has(candidate.status)) ?? sources.runs[0];
  const activeExecutionId = sources.executions.find((execution) =>
    ACTIVE_EXECUTION_STATUSES.has(execution.status),
  )?.executionId;
  const completedTasks = tasks.filter((task) => task.state === "done").length;
  const progress =
    tasks.length === 0
      ? sources.detail.status === "completed"
        ? 100
        : 0
      : Math.round((completedTasks / tasks.length) * 100);

  return {
    id: sources.detail.workId,
    title: sources.detail.title,
    status: projectWorkStatus(sources.detail.status),
    revision: sources.detail.revision,
    sourceStatus: sources.detail.status,
    team: sources.detail.workspaceId === undefined ? "Massion" : "워크스페이스",
    updatedAt: sources.detail.updatedAt ?? sources.detail.createdAt ?? "",
    summary: sources.activities.find((activity) => activity.detail !== undefined)?.detail ?? sources.detail.title,
    progress,
    ...(run === undefined ? {} : { run: projectRun(run) }),
    ...(activeExecutionId === undefined ? {} : { activeExecutionId }),
    approvals,
    tasks,
    agents,
    artifacts,
    verifications: sources.verifications.map(projectVerification),
    activities: projectActivities(sources.activities, sources.approvals, sources.directives, artifacts),
  };
}

function projectWorkStatus(status: string): WorkStatus {
  if (status === "completed") return "complete";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "active";
}

function workStatusFilter(status: WorkStatus): DesktopFilter {
  return status === "active" ? "active" : "complete";
}

function projectRun(run: RunViewV1): RunView {
  return {
    runId: run.runId,
    status: run.status,
    stage: run.stage,
    leaseGeneration: run.leaseGeneration,
    ...(run.approvalId === undefined ? {} : { approvalId: run.approvalId }),
    ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason }),
  };
}

function projectTask(task: TaskViewV1): TaskView {
  const time = task.updatedAt ?? task.createdAt;
  return {
    id: task.taskId,
    title: task.title,
    state: projectStepState(task.status),
    ...(time === undefined ? {} : { time }),
  };
}

function projectStepState(status: string): StepState {
  if (new Set(["completed", "done", "passed", "succeeded"]).has(status)) return "done";
  if (new Set(["active", "running", "verifying"]).has(status)) return "active";
  if (new Set(["blocked", "cancelled", "failed"]).has(status)) return "failed";
  return "pending";
}

function projectAgents(assignments: readonly AssignmentViewV1[], executions: readonly ExecutionViewV1[]): AgentView[] {
  const agents = new Map<string, AgentView>();
  for (const assignment of assignments) {
    const execution = executions.find((candidate) => candidate.agentHandle === assignment.agentHandle);
    agents.set(assignment.agentHandle, {
      id: assignment.assignmentId ?? assignment.agentHandle,
      role: execution?.modelRoute ?? "에이전트",
      name: assignment.agentHandle,
      initials: initials(assignment.agentHandle),
      state:
        ACTIVE_AGENT_STATUSES.has(assignment.status) ||
        (execution !== undefined && ACTIVE_EXECUTION_STATUSES.has(execution.status))
          ? "active"
          : "waiting",
    });
  }
  for (const execution of executions) {
    if (agents.has(execution.agentHandle)) continue;
    agents.set(execution.agentHandle, {
      id: execution.agentHandle,
      role: execution.modelRoute,
      name: execution.agentHandle,
      initials: initials(execution.agentHandle),
      state: ACTIVE_EXECUTION_STATUSES.has(execution.status) ? "active" : "waiting",
    });
  }
  return [...agents.values()];
}

function projectArtifact(artifact: ArtifactViewV1): ArtifactView {
  return {
    id: artifact.artifactVersionId,
    name: artifact.name,
    format: artifactFormat(artifact),
    size: "메타데이터",
    createdAt: artifact.createdAt,
    artifactId: artifact.artifactId,
    artifactVersionId: artifact.artifactVersionId,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    checksum: artifact.checksum,
    version: artifact.version,
    createdBy: artifact.createdBy,
  };
}

function artifactFormat(artifact: ArtifactViewV1): string {
  const mediaType = artifact.mediaType.toLocaleLowerCase();
  const kind = artifact.kind.toLocaleLowerCase();
  if (mediaType === "application/pdf" || kind === "pdf") return "PDF";
  if (mediaType.includes("csv") || kind === "csv") return "CSV";
  const extension = artifact.name.split(".").at(-1);
  return extension === undefined || extension === artifact.name
    ? artifact.kind.toLocaleUpperCase()
    : extension.toLocaleUpperCase();
}

const VERIFICATION_CRITERION_STATUSES = new Set<VerificationCriterionStatus>([
  "passed",
  "failed",
  "blocked",
  "excluded",
]);

/** 계약이 criteria를 unknown으로 싣기 때문에 화면 경계에서 좁힙니다. 알 수 없는 항목은 지어내지 않고 버립니다. */
function projectVerificationCriteria(value: unknown): VerificationCriterionView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): VerificationCriterionView[] => {
    if (!item || typeof item !== "object") return [];
    const { criterionKey, status } = item as Record<string, unknown>;
    if (typeof criterionKey !== "string" || !criterionKey) return [];
    if (typeof status !== "string" || !VERIFICATION_CRITERION_STATUSES.has(status as VerificationCriterionStatus)) {
      return [];
    }
    return [{ key: criterionKey, status: status as VerificationCriterionStatus }];
  });
}

function projectVerification(verification: VerificationViewV1): VerificationView {
  return {
    id: verification.verificationId,
    verifier: verification.verifierId,
    state: verification.passed ? "done" : "failed",
    criteria: projectVerificationCriteria(verification.criteria),
    ...(verification.evidenceArtifactVersionIds.length === 0
      ? {}
      : { evidence: verification.evidenceArtifactVersionIds.join(", ") }),
  };
}

function projectApproval(approval: ApprovalViewV1): ApprovalView {
  return {
    id: approval.approvalId,
    action: approval.action,
    title: approval.displayPreview?.title ?? approval.action,
    description: approvalDescription(approval),
    ...(approval.workId === undefined ? {} : { workId: approval.workId }),
    revision: approval.revision,
    status: approval.status,
  };
}

function approvalDescription(approval: ApprovalViewV1): string {
  const preview = approval.displayPreview;
  if (preview?.reason !== undefined) return preview.reason;
  if (preview?.kind === "command") return [preview.executable, ...preview.arguments].join(" ");
  if (preview?.kind === "file-change") return `${preview.path} · ${preview.summary}`;
  return `${approval.requestedBy} · ${approval.expiresAt} 만료`;
}

function projectActivities(
  activities: readonly WorkActivityViewV1[],
  sourceApprovals: readonly ApprovalViewV1[],
  directives: readonly DirectiveViewV1[],
  artifacts: readonly ArtifactView[],
): ActivityView[] {
  const approvalsById = new Map(sourceApprovals.map((approval) => [approval.approvalId, approval]));
  const projected = activities.map((activity) => projectActivity(activity, approvalsById));
  const representedApprovalIds = new Set(
    projected.flatMap((activity) => (activity.kind === "approval" ? [activity.approvalId] : [])),
  );

  for (const approval of sourceApprovals) {
    if (approval.status !== "pending" || representedApprovalIds.has(approval.approvalId)) continue;
    const view = projectApproval(approval);
    projected.push({
      id: `approval:${approval.approvalId}`,
      kind: "approval",
      time: approval.createdAt ?? approval.expiresAt,
      approvalId: approval.approvalId,
      title: view.title,
      description: view.description,
    });
  }

  for (const directive of directives) {
    projected.push({
      id: `directive:${directive.directiveId}`,
      kind: "message",
      time: directive.createdAt,
      author: "사용자",
      initials: "U",
      content: directive.content,
    });
  }

  if (artifacts.length > 0) {
    projected.push({
      id: "artifacts:current",
      kind: "artifacts",
      time: artifacts[0]?.createdAt ?? "",
      title: "산출물",
      artifacts: [...artifacts],
    });
  }
  return projected.sort((left, right) => left.time.localeCompare(right.time) || left.id.localeCompare(right.id));
}

function projectActivity(
  activity: WorkActivityViewV1,
  approvalsById: ReadonlyMap<string, ApprovalViewV1>,
): ActivityView {
  const approval = activity.resourceId === undefined ? undefined : approvalsById.get(activity.resourceId);
  if (activity.kind === "approval" && approval !== undefined) {
    const view = projectApproval(approval);
    return {
      id: activity.activityId,
      kind: "approval",
      time: activity.createdAt,
      approvalId: approval.approvalId,
      title: view.title,
      description: activity.detail ?? view.description,
    };
  }
  if (activity.kind !== "message") {
    return {
      id: activity.activityId,
      kind: "event",
      time: activity.createdAt,
      title: activity.title,
      detail: activity.detail ?? "",
      status: activity.status ?? "",
    };
  }
  const author = activity.authorId ?? "Massion";
  return {
    id: activity.activityId,
    kind: "message",
    time: activity.createdAt,
    author,
    initials: initials(author),
    content: activity.detail ?? activity.title,
  };
}

function requireRun(work: WorkView): RunView {
  if (work.run === undefined) throw new Error("Work에 제어할 run이 없습니다");
  return work.run;
}

function initials(value: string): string {
  return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? "M";
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
