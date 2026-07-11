import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { connectionFromStatus, useConsoleStatus, useQueryErrors, useSession } from "../hooks.js";
import { api, consoleStore, liveConnection, sessionStore } from "../services.js";

const navigation = [
  ["/", "01", "개요"],
  ["/organization", "02", "조직"],
  ["/approvals", "03", "승인"],
  ["/audit", "04", "감사"],
  ["/memory", "05", "기억"],
  ["/extensions", "06", "확장"],
  ["/access", "07", "접근"],
] as const;

export function RootShell() {
  const session = useSession(sessionStore);
  const status = useConsoleStatus(consoleStore);
  const queryErrors = useQueryErrors(consoleStore);
  const navigate = useNavigate();

  useEffect(() => {
    void api.recoverSession().then(
      (value) => {
        sessionStore.authenticate(value);
        void consoleStore
          .load()
          .then(() => {
            liveConnection.start();
          })
          .catch((error: unknown) => {
            console.error("Massion 운영 데이터 초기화 실패", error);
            consoleStore.setConnection("degraded");
          });
      },
      (error: unknown) => {
        if (location.pathname !== "/login") console.error("Massion 브라우저 session 복구 실패", error);
        sessionStore.anonymous();
      },
    );
    return () => {
      liveConnection.stop();
    };
  }, []);

  useEffect(() => {
    if (session.status === "anonymous" && location.pathname !== "/login") void navigate({ to: "/login" });
  }, [navigate, session.status]);

  if (location.pathname === "/login") return <Outlet />;
  if (session.status === "checking")
    return (
      <main className="boot-screen" aria-live="polite">
        <p className="eyebrow">MASSION / CONTROL OFFICE</p>
        <h1>조직의 현재 상태를 확인하고 있습니다.</h1>
        <div className="boot-line" aria-hidden="true" />
      </main>
    );

  const connection = connectionFromStatus(status);
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <aside className="side-rail" aria-label="주요 메뉴">
        <Link to="/" className="brand-block" aria-label="Massion 운영 개요">
          <span className="brand-mark">M</span>
          <span>MASSION</span>
          <small>CONTROL OFFICE</small>
        </Link>
        <nav>
          {navigation.map(([to, number, label]) => (
            <Link key={to} to={to} activeProps={{ "aria-current": "page" }}>
              <span>{number}</span>
              {label}
            </Link>
          ))}
        </nav>
        <div className="rail-foot">
          <span className={`connection-dot connection-${connection}`} aria-hidden="true" />
          <div>
            <strong>{connection.toUpperCase()}</strong>
            <small>SEQ {consoleStore.getSnapshot().cursor.toString().padStart(6, "0")}</small>
          </div>
        </div>
      </aside>
      <main id="main-content" className="main-stage" tabIndex={-1}>
        {Object.keys(queryErrors).length > 0 ? (
          <div className="query-error-banner" role="alert">
            <strong>일부 운영 데이터를 읽지 못했습니다.</strong>
            <span>{Object.values(queryErrors)[0]}</span>
          </div>
        ) : null}
        <Outlet />
      </main>
      <div className="sr-only" role="status" aria-live="polite">
        실시간 연결 상태: {connection}
      </div>
    </div>
  );
}
