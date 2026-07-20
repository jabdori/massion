import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { label, object, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader, StatusStamp } from "../components/States.js";

function runIdFrom(value: unknown): string | undefined {
  const runId = object(object(value).data).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const works = useQueryData<unknown>(consoleStore, "work.list");
  const approvals = useQueryData<unknown>(consoleStore, "governance.approval.list");
  const snapshot = useQueryData<unknown>(consoleStore, "organization.graph.snapshot");
  const [request, setRequest] = useState("");
  const [runId, setRunId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [starting, setStarting] = useState(false);
  const runPayload = useMemo(() => ({ runId: runId ?? "" }), [runId]);
  const runData = useQueryData<unknown>(consoleStore, "run.get", runPayload, undefined, {
    enabled: runId !== undefined,
  });
  const workRows = rows(works);
  const approvalRows = rows(approvals);
  const graph = object(snapshot);
  const nodes = rows(graph.nodes);
  const executions = rows(graph.executions);
  const running = executions.filter((item) => ["queued", "running", "suspended"].includes(label(item.status, "")));
  const run = object(runData);
  const runWorkId = label(run.workId, "");

  useEffect(() => {
    if (!runWorkId) return;
    void navigate({ to: "/works/$workId", params: { workId: runWorkId } });
  }, [navigate, runWorkId]);

  async function startWork(event: { preventDefault(): void }) {
    event.preventDefault();
    const text = request.trim();
    if (!text || starting) return;
    setStarting(true);
    setNotice(undefined);
    try {
      const result = await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: "run.start",
        payload: { request: { text, surface: "web" } },
      });
      const acceptedRunId = runIdFrom(result);
      if (!acceptedRunId) throw new Error("새 업무 실행 식별자를 받지 못했습니다.");
      setRequest("");
      setRunId(acceptedRunId);
      setNotice("Core Office가 업무를 준비하고 있습니다.");
    } catch {
      setNotice("업무를 시작하지 못했습니다.");
    } finally {
      setStarting(false);
    }
  }

  if (works === undefined || approvals === undefined || snapshot === undefined) return <LoadingState />;
  return (
    <>
      <PageHeader
        index="01 / OPERATIONS"
        title="조직은 지금 무엇을 하고 있나요?"
        description="업무, 에이전트 실행, 승인 요청과 최근 사건을 한 화면에서 확인합니다."
      />
      <section className="work-launcher" aria-labelledby="work-launcher-title">
        <div>
          <p className="eyebrow">NEW WORK</p>
          <h2 id="work-launcher-title">지금 무엇을 함께 할까요?</h2>
          <p>한 문장으로 적으면 Core Office가 업무와 협업 흐름을 시작합니다.</p>
        </div>
        <form
          onSubmit={(event) => {
            void startWork(event);
          }}
        >
          <label htmlFor="work-request">새 업무 요청</label>
          <textarea
            id="work-request"
            value={request}
            onChange={(event) => {
              setRequest(event.target.value);
            }}
            maxLength={16_000}
            rows={3}
            placeholder="예: 이번 주 제품 출시 계획을 정리하고 필요한 작업을 나눠주세요."
          />
          <div>
            <span role="status" aria-live="polite">
              {notice}
            </span>
            <button className="primary-button" type="submit" disabled={starting || !request.trim()}>
              {starting ? "업무 준비 중" : "업무 시작"}
            </button>
          </div>
        </form>
        {runId ? (
          <div className="run-progress" role="status" aria-live="polite">
            <span className="eyebrow">RUN IN PROGRESS</span>
            <StatusStamp value={label(run.status, "preparing").toUpperCase()} />
            <strong>{label(run.stage, "preparing").toUpperCase()}</strong>
            {runWorkId ? <code>{runWorkId}</code> : <span>업무를 만들고 있습니다.</span>}
          </div>
        ) : null}
      </section>
      <section className="metric-rack" aria-label="운영 요약">
        <article>
          <span>ACTIVE WORK</span>
          <strong>
            {workRows
              .filter((item) => label(item.status) !== "completed")
              .length.toString()
              .padStart(2, "0")}
          </strong>
          <small>전체 {workRows.length}건</small>
        </article>
        <article>
          <span>AGENTS ONLINE</span>
          <strong>{running.length.toString().padStart(2, "0")}</strong>
          <small>등록 {nodes.length}명</small>
        </article>
        <article className={approvalRows.length > 0 ? "metric-alert" : ""}>
          <span>NEEDS DECISION</span>
          <strong>{approvalRows.length.toString().padStart(2, "0")}</strong>
          <small>{approvalRows.length > 0 ? "검토가 필요합니다" : "대기 없음"}</small>
        </article>
        <article>
          <span>EVENT CURSOR</span>
          <strong>{consoleStore.getSnapshot().cursor.toString().padStart(6, "0")}</strong>
          <small>실시간 원장</small>
        </article>
      </section>
      <div className="dashboard-grid">
        <section className="ledger-panel work-register">
          <div className="panel-title">
            <div>
              <p className="eyebrow">WORK REGISTER</p>
              <h2>진행 중인 업무</h2>
            </div>
            <span>{workRows.length}</span>
          </div>
          {workRows.length === 0 ? (
            <EmptyState title="아직 시작된 업무가 없습니다" detail="위 입력창에 첫 업무를 적어 시작해주세요." />
          ) : (
            <div className="ledger-list">
              {workRows.slice(0, 8).map((work) => (
                <Link
                  key={label(work.workId)}
                  to="/works/$workId"
                  params={{ workId: label(work.workId) }}
                  className="ledger-row"
                >
                  <span className="mono">{label(work.workId).slice(0, 12)}</span>
                  <strong>업무 #{label(work.revision, "0")}</strong>
                  <StatusStamp value={label(work.status)} />
                  <span aria-hidden="true">↗</span>
                </Link>
              ))}
            </div>
          )}
        </section>
        <section className="ledger-panel agent-register">
          <div className="panel-title">
            <div>
              <p className="eyebrow">ACTIVE OFFICE</p>
              <h2>에이전트 배치</h2>
            </div>
            <Link to="/organization">전체 보기</Link>
          </div>
          <div className="agent-stack">
            {nodes.slice(0, 6).map((node, index) => (
              <article key={label(node.handle)}>
                <span className="agent-index">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{label(node.name)}</strong>
                  <small>{label(node.responsibility)}</small>
                </div>
                <StatusStamp value={label(node.executionStatus, label(node.status))} />
              </article>
            ))}
          </div>
        </section>
        <section className="ledger-panel approval-strip">
          <div className="panel-title">
            <div>
              <p className="eyebrow">DECISION QUEUE</p>
              <h2>선택이 필요한 항목</h2>
            </div>
            <Link to="/approvals">승인함 열기</Link>
          </div>
          {approvalRows.length === 0 ? (
            <p className="quiet-line">현재 대기 중인 승인 요청이 없습니다.</p>
          ) : (
            approvalRows.slice(0, 3).map((item) => (
              <div className="approval-line" key={label(item.approvalId)}>
                <StatusStamp value="PENDING" />
                <strong>{label(item.action)}</strong>
                <span>{label(item.requestedBy)}</span>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  );
}
