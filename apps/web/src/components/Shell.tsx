import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { connectionFromStatus, useConsoleStatus, useQueryData, useQueryErrors, useSession } from "../hooks.js";
import { api, consoleStore, liveConnection, sessionStore } from "../services.js";
import { label, rows } from "../data.js";

// 기본 내비게이션: 홈 / 확인할 것 / 결과
const primaryNavigation = [
  ["/", "홈"],
  ["/works", "작업"],
  ["/approvals", "확인할 것"],
  ["/audit", "결과"],
] as const;

// 더보기 서브메뉴: 설정 및 시스템 항목
const moreNavigation = [
  ["/organization", "역할과 권한"],
  ["/subscriptions", "연결된 AI"],
  ["/extensions", "앱 및 연동"],
  ["/access", "시스템 상태"],
] as const;

export function RootShell() {
  const session = useSession(sessionStore);
  const status = useConsoleStatus(consoleStore);
  const queryErrors = useQueryErrors(consoleStore);
  const approvalData = useQueryData<unknown>(consoleStore, "governance.approval.list");
  const pendingApprovals = approvalData !== undefined ? rows(approvalData).length : 0;
  const navigate = useNavigate();
  // 더보기 서브메뉴 펼침/절첨 상태
  const [moreOpen, setMoreOpen] = useState(false);

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
        <p className="eyebrow">MASSION</p>
        <h1>잠시만 기다려주세요. 준비하고 있습니다.</h1>
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
        </Link>
        <nav>
          {primaryNavigation.map(([to, navLabel]) => (
            <Link key={to} to={to} activeProps={{ "aria-current": "page" }}>
              {navLabel}
              {to === "/approvals" && pendingApprovals > 0 ? (
                <span className="nav-badge">{pendingApprovals}</span>
              ) : null}
            </Link>
          ))}
          <button
            type="button"
            className="nav-more-toggle"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((value) => !value)}
          >
            더보기
          </button>
          {moreOpen ? (
            <div className="nav-more-section">
              {moreNavigation.map(([to, label]) => (
                <Link key={to} to={to} activeProps={{ "aria-current": "page" }}>
                  {label}
                </Link>
              ))}
            </div>
          ) : null}
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
