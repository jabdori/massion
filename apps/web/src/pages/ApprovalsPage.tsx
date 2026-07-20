import { useState } from "react";

import { approvalRiskFromPreview } from "@massion/application";

import { label, list, object, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState } from "../components/States.js";

function ApprovalDetail({ value, approvalId }: { readonly value: unknown; readonly approvalId: string }) {
  const preview = object(value);
  const kind = preview.kind;
  if (kind !== "command" && kind !== "file-change" && kind !== "provider") return null;

  const title = label(preview.title, "승인 내용");
  const reason = typeof preview.reason === "string" ? preview.reason : undefined;
  const risk = approvalRiskFromPreview({ kind });

  return (
    <section className="approval-preview" aria-label={`${approvalId} 승인 내용`}>
      {/* 친화적 위험도 표현 */}
      <div className={`risk-banner risk-${risk.semantic}`} role="note">
        <strong>{risk.friendlyLabel}</strong>
        <p>{risk.description}</p>
      </div>

      <h3>{title}</h3>

      {kind === "command" ? (
        <dl>
          <div>
            <dt>실행 파일</dt>
            <dd className="mono">{label(preview.executable)}</dd>
          </div>
          <div>
            <dt>인수</dt>
            <dd className="mono">{list(preview.arguments).slice(0, 16).join(" ") || "없음"}</dd>
          </div>
          {typeof preview.cwd === "string" ? (
            <div>
              <dt>작업 경로</dt>
              <dd className="mono">{preview.cwd}</dd>
            </div>
          ) : null}
        </dl>
      ) : kind === "file-change" ? (
        <dl>
          <div>
            <dt>변경 경로</dt>
            <dd className="mono">{label(preview.path)}</dd>
          </div>
          <div>
            <dt>변경 요약</dt>
            <dd>{label(preview.summary)}</dd>
          </div>
        </dl>
      ) : null}

      {reason ? (
        <div className="approval-reason">
          <p className="eyebrow">요청 이유</p>
          <p>{reason}</p>
        </div>
      ) : null}
    </section>
  );
}

export default function ApprovalsPage() {
  const data = useQueryData<unknown>(consoleStore, "governance.approval.list");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  if (data === undefined) return <LoadingState label="확인할 항목을 불러오고 있습니다" />;

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
      {/* 친화적 헤더 */}
      <section className="greeting-section">
        <h1>확인이 필요해요</h1>
        <p>Massion이 진행하려는 작업 중 사용자 확인이 필요한 항목입니다.</p>
      </section>

      <div className="live-notice" role="status" aria-live="polite">
        {notice ?? (approvals.length > 0 ? `${String(approvals.length)}개의 항목이 대기 중입니다.` : "모두 확인되었습니다.")}
      </div>

      {approvals.length === 0 ? (
        <EmptyState
          title="확인할 항목이 없습니다"
          detail="자동 반영이 허용된 작업은 확인을 거치지 않고 진행됩니다."
          hint="되돌리기 어려운 변경(예: 데이터 삭제)만 따로 확인을 요청합니다."
        />
      ) : (
        <section className="decision-list" aria-label="확인 요청">
          {approvals.map((approval) => {
            const id = label(approval.approvalId);
            return (
              <article key={id} className="approval-card-detailed">
                <header className="approval-card-header">
                  <span className="status-symbol">?</span>
                  <span>확인이 필요해요</span>
                </header>

                <h2 className="approval-card-title">{label(approval.action)}</h2>

                <ApprovalDetail value={approval.displayPreview} approvalId={id} />

                <div className="approval-card-meta">
                  <span>요청자: {label(approval.requestedBy)}</span>
                  {label(approval.expiresAt) ? <span>만료: {label(approval.expiresAt)}</span> : null}
                </div>

                <div className="decision-actions">
                  <button
                    type="button"
                    className="secondary-button danger"
                    disabled={busy === id}
                    aria-label={`${label(approval.action)} 거부`}
                    onClick={() => void vote(id, "reject")}
                  >
                    지금은 하지 않기
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy === id}
                    aria-label={`${label(approval.action)} 승인`}
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
