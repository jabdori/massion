import { label, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function OptimizationPage() {
  const policy = useQueryData<unknown>(consoleStore, "optimization.policy");
  const receipts = useQueryData<unknown>(consoleStore, "optimization.receipts");
  const policyRows = rows(policy);
  const receiptRows = rows(receipts);
  if (policy === undefined || receipts === undefined) return <LoadingState label="모델 평가실을 연결하고 있습니다" />;
  const activePolicy = policyRows[0];
  return (
    <>
      <PageHeader
        index="09 / MODEL LAB"
        title="모델 평가실"
        description="연결한 모델만 역할별로 평가하고, 근거가 있는 추천과 fallback을 관리합니다. 무료 모델을 자동으로 추가하지 않습니다."
      />
      <section className="metric-rack" aria-label="모델 평가 요약">
        <article>
          <span>RECEIPTS</span>
          <strong>{String(receiptRows.length).padStart(2, "0")}</strong>
          <small>저장된 평가 영수증</small>
        </article>
        <article>
          <span>POLICY</span>
          <strong>{activePolicy ? "ON" : "—"}</strong>
          <small>{activePolicy ? label(activePolicy.policy, "review") : "기본 review"}</small>
        </article>
        <article>
          <span>AUTO OPTIMIZE</span>
          <strong>{activePolicy?.autoOptimize === true ? "ON" : "OFF"}</strong>
          <small>조직별 명시 동의</small>
        </article>
      </section>
      <section className="ledger-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">EVALUATION RECEIPTS</p>
            <h2>역할별 평가 기록</h2>
          </div>
          <StatusStamp value={activePolicy ? label(activePolicy.policy, "review") : "review"} />
        </div>
        {receiptRows.length === 0 ? (
          <EmptyState
            title="아직 평가 기록이 없습니다"
            detail="CLI 또는 API에서 평가 bundle과 연결된 모델을 등록해주세요."
          />
        ) : (
          <div className="ledger-list">
            {receiptRows.slice(0, 20).map((receipt) => (
              <div className="ledger-row" key={label(receipt.receiptId)}>
                <span className="mono">{label(receipt.receiptId).slice(0, 12)}</span>
                <strong>{label(receipt.roleKey)}</strong>
                <span>{label(receipt.modelProfileId)}</span>
                <StatusStamp value={receipt.completed === true ? "COMPLETED" : "INCOMPLETE"} />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
