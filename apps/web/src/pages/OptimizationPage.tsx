import { useState } from "react";

import { label, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function OptimizationPage() {
  const policy = useQueryData<unknown>(consoleStore, "optimization.policy");
  const receipts = useQueryData<unknown>(consoleStore, "optimization.receipts");
  const me = useQueryData<unknown>(consoleStore, "identity.me");
  const [selectedPolicy, setSelectedPolicy] = useState("quality");
  const [autoOptimize, setAutoOptimize] = useState(false);
  const [productionLearning, setProductionLearning] = useState(false);
  const [shadowEnabled, setShadowEnabled] = useState(false);
  const [governanceDecisionId, setGovernanceDecisionId] = useState("");
  const [notice, setNotice] = useState<string>();
  const policyRows = rows(policy);
  const receiptRows = rows(receipts);
  if (policy === undefined || receipts === undefined || me === undefined)
    return <LoadingState label="모델 평가실을 연결하고 있습니다" />;
  const activePolicy = policyRows[0];
  const canConfigure =
    label((me as Record<string, unknown>).role) === "owner" || label((me as Record<string, unknown>).role) === "admin";

  async function configurePolicy(): Promise<void> {
    if (!canConfigure || governanceDecisionId.trim().length === 0) {
      setNotice("owner/admin 권한과 거버넌스 결정 ID가 필요합니다.");
      return;
    }
    try {
      await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: "optimization.policy.configure",
        payload: {
          policy: selectedPolicy,
          autoOptimize,
          productionLearning,
          shadowEnabled,
          governanceDecisionId: governanceDecisionId.trim(),
        },
      });
      await consoleStore.refresh("optimization.policy", {});
      setNotice("모델 평가실 정책을 저장했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "모델 평가실 정책을 저장하지 못했습니다.");
    }
  }
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
      <section className="ledger-panel" aria-labelledby="optimization-policy-title">
        <div className="panel-title">
          <div>
            <p className="eyebrow">POLICY CONTROL</p>
            <h2 id="optimization-policy-title">자동화 범위 선택</h2>
          </div>
          <StatusStamp value={canConfigure ? "CONFIGURABLE" : "READ ONLY"} />
        </div>
        <p>무료·공개 모델은 자동으로 추가되지 않으며, 자동 최적화와 실사용 학습은 별도로 동의해야 합니다.</p>
        <div className="form-grid">
          <label>
            비교 정책
            <select
              value={selectedPolicy}
              disabled={!canConfigure}
              onChange={(event) => {
                setSelectedPolicy(event.target.value);
              }}
            >
              <option value="quality">최고 품질</option>
              <option value="value">가성비</option>
              <option value="speed">속도</option>
              <option value="privacy">개인정보 우선</option>
              <option value="manual">수동 고정</option>
            </select>
          </label>
          <label>
            거버넌스 결정 ID
            <input
              value={governanceDecisionId}
              disabled={!canConfigure}
              onChange={(event) => {
                setGovernanceDecisionId(event.target.value);
              }}
              placeholder="승인 기록 ID"
            />
          </label>
        </div>
        <div className="form-grid">
          <label>
            <input
              type="checkbox"
              checked={autoOptimize}
              disabled={!canConfigure}
              onChange={(event) => {
                setAutoOptimize(event.target.checked);
              }}
            />{" "}
            자동 최적화 동의
          </label>
          <label>
            <input
              type="checkbox"
              checked={productionLearning}
              disabled={!canConfigure}
              onChange={(event) => {
                setProductionLearning(event.target.checked);
              }}
            />{" "}
            실사용 학습 동의
          </label>
          <label>
            <input
              type="checkbox"
              checked={shadowEnabled}
              disabled={!canConfigure}
              onChange={(event) => {
                setShadowEnabled(event.target.checked);
              }}
            />{" "}
            shadow 실행 동의
          </label>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={!canConfigure}
          onClick={() => void configurePolicy()}
        >
          정책 저장
        </button>
        <div className="live-notice" role="status" aria-live="polite">
          {notice ?? (activePolicy ? `현재 ${label(activePolicy.policy, "review")} 정책` : "현재 기본 review 정책")}
        </div>
      </section>
    </>
  );
}
