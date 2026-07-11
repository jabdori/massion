import { useState } from "react";

import { label, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function ApprovalsPage() {
  const data = useQueryData<unknown>(consoleStore, "governance.approval.list");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  if (data === undefined) return <LoadingState label="승인 원장을 읽고 있습니다" />;
  const approvals = rows(data);

  async function vote(approvalId: string, decision: "approve" | "reject") {
    const commandId = crypto.randomUUID();
    setBusy(approvalId);
    setNotice(undefined);
    try {
      await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId,
        correlationId: crypto.randomUUID(),
        operation: "approval.vote",
        payload: { approvalId, vote: decision, reason: `Web Console에서 ${decision}` },
      });
      await consoleStore.refresh("governance.approval.list");
      setNotice(decision === "approve" ? "승인했습니다." : "거절했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "처리하지 못했습니다.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      <PageHeader
        index="03 / DECISIONS"
        title="어떤 결정이 기다리고 있나요?"
        description="조직 정책에 따라 사람 검토가 필요한 작업만 이곳에 도착합니다."
      />
      <div className="live-notice" role="status" aria-live="polite">
        {notice ?? `${String(approvals.length)}개의 결정이 대기 중입니다.`}
      </div>
      {approvals.length === 0 ? (
        <EmptyState
          title="결정 대기열이 비었습니다"
          detail="자동 반영 정책이 허용한 작업은 승인함을 거치지 않습니다."
        />
      ) : (
        <section className="decision-list" aria-label="승인 요청">
          {approvals.map((approval, index) => {
            const id = label(approval.approvalId);
            return (
              <article key={id}>
                <header>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <StatusStamp value={label(approval.status)} />
                </header>
                <h2>{label(approval.action)}</h2>
                <dl>
                  <div>
                    <dt>요청자</dt>
                    <dd>{label(approval.requestedBy)}</dd>
                  </div>
                  <div>
                    <dt>만료</dt>
                    <dd>{label(approval.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt>식별자</dt>
                    <dd className="mono">{id}</dd>
                  </div>
                </dl>
                <div className="decision-actions">
                  <button
                    type="button"
                    className="secondary-button danger"
                    disabled={busy === id}
                    onClick={() => void vote(id, "reject")}
                  >
                    거절
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy === id}
                    onClick={() => void vote(id, "approve")}
                  >
                    {busy === id ? "반영 중…" : "승인"}
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </>
  );
}
