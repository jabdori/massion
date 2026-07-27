import { Component, type ReactNode } from "react";

/**
 * 지도가 죽어도 조직 화면 전체가 무너지면 안 됩니다. ReactFlow는 크기 측정이 안 되는 환경
 * (jsdom 등)에서 렌더 중 예외를 던지므로, 지도만 조용히 접고 구조(A)는 계속 보이게 합니다.
 */
export class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  public override state = { failed: false };
  public static getDerivedStateFromError() {
    return { failed: true };
  }
  public override render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-muted">
          지도를 그릴 수 없습니다
        </div>
      );
    }
    return this.props.children;
  }
}

export function GrowthSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section aria-label={title} className="mt-7">
      <h3 className="mb-2.5 text-[10px] font-semibold tracking-[0.08em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

export function SurfaceLoading() {
  return (
    <div role="status" className="text-sm text-secondary">
      불러오는 중…
    </div>
  );
}
export function SurfaceError({ message }: { message: string }) {
  return (
    <p role="alert" className="mb-4 text-sm text-danger">
      {message}
    </p>
  );
}
export function surfaceErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
