import type { ReactNode } from "react";

export function LoadingState({ label = "운영 데이터를 읽고 있습니다" }: { readonly label?: string }) {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <span className="pulse-mark" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="state-panel state-empty">
      <p className="eyebrow">EMPTY REGISTER</p>
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}

export function ErrorState({
  title = "데이터를 표시할 수 없습니다",
  detail,
}: {
  readonly title?: string;
  readonly detail: string;
}) {
  return (
    <div className="state-panel state-error" role="alert">
      <p className="eyebrow">OPERATION DEGRADED</p>
      <h2>{title}</h2>
      <p>{detail}</p>
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
