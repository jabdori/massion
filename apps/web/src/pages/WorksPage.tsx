import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { workStatusToken } from "@massion/application";

import { label, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader } from "../components/States.js";

export default function WorksPage() {
  const data = useQueryData<unknown>(consoleStore, "work.list");
  const workspacesData = useQueryData<unknown>(consoleStore, "workspace.list");
  const [workspaceFilter, setWorkspaceFilter] = useState("all");

  if (data === undefined) return <LoadingState label="작업 목록을 불러오고 있습니다" />;

  const workspaces = rows(workspacesData);
  const allWorks = rows(data);
  const works =
    workspaceFilter === "all" ? allWorks : allWorks.filter((item) => label(item.workspaceId) === workspaceFilter);
  const activeWorks = works.filter((item) => ["running", "blocked", "awaiting-approval"].includes(label(item.status)));
  const completedWorks = works.filter((item) => label(item.status) === "completed");

  return (
    <>
      <PageHeader index="" title="작업" description="진행 중인 작업과 완료된 결과를 확인할 수 있습니다." />
      {workspaces.length > 0 ? (
        <div className="composer-inline" style={{ marginBottom: "16px" }}>
          <label htmlFor="workspace-filter">워크스페이스</label>
          <select
            id="workspace-filter"
            aria-label="워크스페이스 필터"
            value={workspaceFilter}
            onChange={(event) => {
              setWorkspaceFilter(event.target.value);
            }}
          >
            <option value="all">전체 워크스페이스</option>
            {workspaces.map((workspace) => (
              <option key={label(workspace.workspaceId)} value={label(workspace.workspaceId)}>
                {label(workspace.name)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {works.length === 0 ? (
        <EmptyState
          title="아직 작업이 없습니다"
          detail="홈에서 새 요청을 만들면 여기에 표시됩니다."
          hint="예: '이번 주 회의 자료 정리해줘'처럼 한 문장으로 요청해보세요."
        />
      ) : (
        <>
          {activeWorks.length > 0 ? (
            <section className="home-section">
              <h2 className="home-section-title">
                진행 중인 작업
                <span className="home-section-count">{activeWorks.length}</span>
              </h2>
              <div className="card-grid">
                {activeWorks.map((work) => {
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
                      <p className="work-card-title">{label(work.title, `업무 ${label(work.revision, "")}`)}</p>
                    </Link>
                  );
                })}
              </div>
            </section>
          ) : null}

          {completedWorks.length > 0 ? (
            <section className="home-section">
              <h2 className="home-section-title">완료된 작업</h2>
              <div className="card-list">
                {completedWorks.map((work) => {
                  const token = workStatusToken(label(work.status));
                  return (
                    <Link
                      key={label(work.workId)}
                      to="/works/$workId"
                      params={{ workId: label(work.workId) }}
                      className="recent-result"
                    >
                      <span className="recent-result-symbol">{token.symbol}</span>
                      <span className="recent-result-title">
                        {label(work.title, `업무 ${label(work.revision, "")}`)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
