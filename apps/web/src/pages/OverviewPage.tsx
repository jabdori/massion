import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { userStageForInternal, workStatusToken } from "@massion/application";

import { label, object, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { LoadingState, StatusStamp } from "../components/States.js";

function runIdFrom(value: unknown): string | undefined {
  const runId = object(object(value).data).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

const QUICK_EXAMPLES = ["문서 작성해주세요", "자료 조사해주세요", "개발 작업을 진행해주세요", "일정을 정리해주세요"];

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
  const run = object(runData);
  const runWorkId = label(run.workId, "");

  // 진행 중이거나 확인이 필요한 작업
  const activeWorks = workRows.filter((item) =>
    ["running", "blocked", "awaiting-approval"].includes(label(item.status)),
  );
  const completedWorks = workRows.filter((item) => label(item.status) === "completed");

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
      setNotice("업무를 준비하고 있습니다.");
    } catch {
      setNotice("업무를 시작하지 못했습니다.");
    } finally {
      setStarting(false);
    }
  }

  if (works === undefined || approvals === undefined || snapshot === undefined) return <LoadingState />;

  const runStatus = label(run.status, "preparing");
  const runStage = label(run.stage, "intake");
  const runStatusToken = workStatusToken(runStatus);
  const runStageToken = userStageForInternal(runStage);

  return (
    <>
      {/* 환영 인사 */}
      <section className="greeting-section">
        <h1>안녕하세요. 무엇을 도와드릴까요?</h1>
        <p>한 문장으로 말씀해주시면 정리해서 진행합니다.</p>
      </section>

      {/* 빠른 시작: 입력창 + 예시 버튼 */}
      <section className="quick-start">
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
        <div className="quick-examples">
          {QUICK_EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="example-chip"
              onClick={() => setRequest(example)}
            >
              {example.replace("해주세요", "")}
            </button>
          ))}
        </div>
        {/* 실행 진행 상태 (친화적 라벨) */}
        {runId ? (
          <div className="run-progress-friendly" role="status" aria-live="polite">
            <span className={`friendly-status is-${runStatusToken.semantic}`}>
              <span className="status-symbol">{runStatusToken.symbol}</span>
              {runStatusToken.friendlyLabel}
            </span>
            <span>{runStageToken.friendlyLabel} 단계</span>
            {runWorkId ? <code>{runWorkId}</code> : <span>업무를 만들고 있습니다.</span>}
          </div>
        ) : null}
      </section>

      {/* 확인이 필요해요 */}
      <section className="home-section">
        <h2 className="home-section-title">
          확인이 필요해요
          {approvalRows.length > 0 ? (
            <span className="home-section-count">{approvalRows.length}</span>
          ) : null}
          {approvalRows.length > 0 ? (
            <Link to="/approvals" className="home-section-link">
              모두 보기
            </Link>
          ) : null}
        </h2>
        {approvalRows.length === 0 ? (
          <p className="quiet-line">현재 확인이 필요한 항목이 없습니다.</p>
        ) : (
          <div className="card-grid">
            {approvalRows.slice(0, 6).map((item) => (
              <article className="approval-card" key={label(item.approvalId)}>
                <div className="approval-card-header">
                  <span className="status-symbol">?</span>
                  확인이 필요해요
                </div>
                <p className="approval-card-title">{label(item.action)}</p>
                <p className="approval-card-meta">{label(item.requestedBy)}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 진행 중인 작업 */}
      <section className="home-section">
        <h2 className="home-section-title">
          진행 중인 작업
          {activeWorks.length > 0 ? (
            <span className="home-section-count">{activeWorks.length}</span>
          ) : null}
        </h2>
        {activeWorks.length === 0 ? (
          <p className="quiet-line">진행 중인 작업이 없습니다.</p>
        ) : (
          <div className="card-grid">
            {activeWorks.slice(0, 6).map((work) => {
              const token = workStatusToken(label(work.status));
              return (
                <Link
                  key={label(work.workId)}
                  to="/works/$workId"
                  params={{ workId: label(work.workId) }}
                  className="work-card"
                >
                  <div className="work-card-header">
                    <span className="work-card-symbol">{token.symbol}</span>
                    <span className="work-card-label">{token.friendlyLabel}</span>
                  </div>
                  <p className="work-card-title">업무 #{label(work.revision, "0")}</p>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* 최근 결과 */}
      <section className="home-section">
        <h2 className="home-section-title">최근 결과</h2>
        {completedWorks.length === 0 ? (
          <p className="quiet-line">완료된 작업이 아직 없습니다.</p>
        ) : (
          <div className="card-list">
            {completedWorks.slice(0, 5).map((work) => (
              <Link
                key={label(work.workId)}
                to="/works/$workId"
                params={{ workId: label(work.workId) }}
                className="recent-result"
              >
                <span className="recent-result-symbol">✓</span>
                <span className="recent-result-title">업무 #{label(work.revision, "0")}</span>
                <StatusStamp value={label(work.status)} />
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
