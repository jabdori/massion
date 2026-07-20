import type { ReactNode } from "react";

export function LoadingState({ label = "운영 데이터를 읽고 있습니다" }: { readonly label?: string }) {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <span className="pulse-mark" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title, detail, hint }: { readonly title: string; readonly detail: string; readonly hint?: string }) {
  return (
    <div className="state-panel state-empty">
      <span className="state-panel-icon" aria-hidden="true">○</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {hint ? <p className="state-panel-hint">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({
  title = "데이터를 표시할 수 없습니다",
  detail,
  guidance,
}: {
  readonly title?: string;
  readonly detail: string;
  readonly guidance?: string;
}) {
  return (
    <div className="state-panel state-error" role="alert">
      <span className="state-panel-icon" aria-hidden="true">!</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      <p className="state-panel-guidance">
        {guidance ?? "잠시 후 다시 시도해주세요. 문제가 계속되면 담당자에게 문의해주세요."}
      </p>
    </div>
  );
}

export function PageHeader({
  index,
  title,
  description,
  action,
}: {
  readonly index: string;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{index}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-action">{action}</div> : null}
    </header>
  );
}

export function StatusStamp({ value }: { readonly value: string }) {
  return <span className={`status-stamp status-${value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}`}>{value}</span>;
}
