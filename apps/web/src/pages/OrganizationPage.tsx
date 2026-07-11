import { label, list, object, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function OrganizationPage() {
  const data = useQueryData<unknown>(consoleStore, "organization.graph.snapshot");
  if (data === undefined) return <LoadingState label="조직도를 조립하고 있습니다" />;
  const snapshot = object(data);
  const nodes = rows(snapshot.nodes);
  if (nodes.length === 0)
    return <EmptyState title="조직 노드가 없습니다" detail="Core Office를 초기화하면 조직 관계가 여기에 표시됩니다." />;
  return (
    <>
      <PageHeader
        index="02 / ORGANIZATION"
        title="에이전트들이 어떻게 협업하나요?"
        description="역할, 책임, Capability와 현재 배정을 그래프와 동일한 접근성 목록으로 제공합니다."
      />
      <div className="organization-layout">
        <section className="graph-panel" aria-labelledby="graph-title">
          <div className="panel-title">
            <div>
              <p className="eyebrow">LIVE COLLABORATION MAP</p>
              <h2 id="graph-title">협업 맵</h2>
            </div>
            <span>REV {label(snapshot.revision).slice(0, 8)}</span>
          </div>
          <svg
            className="agent-graph"
            viewBox="0 0 900 500"
            role="img"
            aria-labelledby="graph-svg-title graph-svg-desc"
          >
            <title id="graph-svg-title">Massion 에이전트 조직 관계</title>
            <desc id="graph-svg-desc">아래 접근 가능한 목록과 동일한 에이전트 배치입니다.</desc>
            <path d="M450 80 V155 M180 155 H720 M180 155 V220 M450 155 V220 M720 155 V220" className="graph-line" />
            {nodes.slice(0, 7).map((node, index) => {
              const points = [
                [450, 55],
                [180, 250],
                [450, 250],
                [720, 250],
                [180, 410],
                [450, 410],
                [720, 410],
              ];
              const point = points[index] ?? [450, 410];
              return (
                <g key={label(node.handle)} transform={`translate(${String(point[0])} ${String(point[1])})`}>
                  <rect x="-105" y="-32" width="210" height="64" rx="2" />
                  <circle cx="-80" cy="0" r="5" />
                  <text x="-62" y="-5">
                    {label(node.name).slice(0, 20)}
                  </text>
                  <text x="-62" y="15" className="graph-meta">
                    {label(node.role).toUpperCase()}
                  </text>
                </g>
              );
            })}
          </svg>
        </section>
        <section className="agent-directory" aria-labelledby="agent-list-title">
          <div className="panel-title">
            <div>
              <p className="eyebrow">ACCESSIBLE DIRECTORY</p>
              <h2 id="agent-list-title">에이전트 명부</h2>
            </div>
            <span>{nodes.length}</span>
          </div>
          <ul>
            {nodes.map((node) => (
              <li key={label(node.handle)} tabIndex={0}>
                <div>
                  <strong>{label(node.name)}</strong>
                  <code>@{label(node.handle)}</code>
                </div>
                <p>{label(node.responsibility)}</p>
                <div className="tag-row">
                  {list(node.capabilities)
                    .slice(0, 3)
                    .map((capability) => (
                      <span key={capability}>{capability}</span>
                    ))}
                </div>
                <StatusStamp value={label(node.executionStatus, label(node.status))} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
