import { useState } from "react";

import { label, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader } from "../components/States.js";

// TUI cwd attach와 같은 workspace.register/trust/archive 계약을 사용합니다.
const TRUST_LABELS: Readonly<Record<string, string>> = {
  pending: "확인 필요",
  trusted: "신뢰함",
  blocked: "차단됨",
};

export default function WorkspacesPage() {
  const data = useQueryData<unknown>(consoleStore, "workspace.list");
  const [notice, setNotice] = useState<string>();
  const [path, setPath] = useState("");

  if (data === undefined) return <LoadingState label="워크스페이스 목록을 불러오고 있습니다" />;
  const workspaces = rows(data);

  async function send(operation: string, payload: Record<string, unknown>, expectedRevision?: number): Promise<void> {
    try {
      await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        payload,
      });
      await consoleStore.refresh("workspace.list", {});
      setNotice("워크스페이스 변경을 반영했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "워크스페이스 변경에 실패했습니다.");
    }
  }

  async function register(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) return;
    await send("workspace.register", { path: trimmed });
    setPath("");
  }

  return (
    <>
      <PageHeader
        index=""
        title="워크스페이스"
        description="Massion이 작업할 디렉토리를 등록하고 신뢰 여부를 결정합니다. 신뢰하기 전에는 도구 실행이 차단됩니다."
      />
      <div className="live-notice" role="status" aria-live="polite">
        {notice}
      </div>

      <section className="home-section">
        <h2 className="home-section-title">디렉토리 등록</h2>
        <form className="composer-inline" onSubmit={(event) => void register(event)}>
          <input
            type="text"
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
            }}
            placeholder="/home/me/projects/my-app"
            aria-label="워크스페이스 경로"
          />
          <button className="primary-button" type="submit" disabled={!path.trim()}>
            등록
          </button>
        </form>
      </section>

      <section className="home-section">
        <h2 className="home-section-title">
          등록된 워크스페이스<span className="home-section-count">{workspaces.length}</span>
        </h2>
        {workspaces.length === 0 ? (
          <EmptyState
            title="등록된 워크스페이스가 없습니다"
            detail="터미널에서 프로젝트 디렉토리로 이동해 massion을 실행하거나 위에서 경로를 등록하세요."
          />
        ) : (
          <div className="card-list">
            {workspaces.map((workspace) => {
              const workspaceId = label(workspace.workspaceId);
              const trust = label(workspace.trust);
              const revision = Number(workspace.revision);
              return (
                <article className="work-card" key={workspaceId}>
                  <div className="work-card-header">
                    <strong>{label(workspace.name)}</strong>
                    <span
                      className={`friendly-status is-${trust === "trusted" ? "ok" : trust === "blocked" ? "danger" : "pending"}`}
                    >
                      {TRUST_LABELS[trust] ?? trust}
                    </span>
                  </div>
                  <code>{label(workspace.path)}</code>
                  <div className="composer-inline-actions">
                    {trust !== "trusted" ? (
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => void send("workspace.trust", { workspaceId, decision: "trusted" }, revision)}
                      >
                        신뢰
                      </button>
                    ) : null}
                    {trust !== "blocked" ? (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void send("workspace.trust", { workspaceId, decision: "blocked" }, revision)}
                      >
                        차단
                      </button>
                    ) : null}
                    <button
                      className="secondary-button danger"
                      type="button"
                      onClick={() => void send("workspace.archive", { workspaceId }, revision)}
                    >
                      보관
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
