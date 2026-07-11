import { useState } from "react";

import { label, object, rows, shortId } from "../data.js";
import { useQueryData } from "../hooks.js";
import { api, consoleStore, sessionStore } from "../services.js";
import { LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function AccessPage() {
  const membersData = useQueryData<unknown>(consoleStore, "identity.memberships");
  const sessionsData = useQueryData<unknown>(consoleStore, "application.sessions");
  const meData = useQueryData<unknown>(consoleStore, "identity.me");
  const [notice, setNotice] = useState<string>();
  if (membersData === undefined || sessionsData === undefined || meData === undefined)
    return <LoadingState label="사용자와 세션 권한을 확인하고 있습니다" />;
  const members = rows(membersData);
  const sessions = rows(sessionsData);
  const me = object(meData);
  const elevated = ["owner", "admin"].includes(label(me.role));

  async function command(operation: string, target: Readonly<Record<string, unknown>>, revision: number) {
    try {
      await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation,
        expectedRevision: revision,
        payload: target,
      });
      await Promise.all([consoleStore.refresh("identity.memberships"), consoleStore.refresh("application.sessions")]);
      setNotice("변경을 반영했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "변경하지 못했습니다.");
    }
  }

  async function logout() {
    try {
      await api.logout();
      sessionStore.anonymous();
      location.assign("/login");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "로그아웃하지 못했습니다.");
    }
  }
  return (
    <>
      <PageHeader
        index="07 / ACCESS CONTROL"
        title="누가 어떤 권한으로 접속하나요?"
        description="조직 구성원 역할과 현재 사용자의 브라우저 세션을 개정 번호 조건으로 관리합니다."
        action={
          <button type="button" className="secondary-button" onClick={() => void logout()}>
            현재 세션 로그아웃
          </button>
        }
      />
      <div className="live-notice" role="status" aria-live="polite">
        {notice ?? "권한 변경은 다음 요청부터 즉시 적용됩니다."}
      </div>
      <div className="access-layout">
        <section className="ledger-panel">
          <div className="panel-title">
            <div>
              <p className="eyebrow">MEMBERSHIPS</p>
              <h2>조직 구성원</h2>
            </div>
            <span>{members.length}</span>
          </div>
          <div className="access-list">
            {members.map((member) => (
              <article key={label(member.membershipId)}>
                <div className="avatar-box">{label(member.displayName, "?").slice(0, 1).toUpperCase()}</div>
                <div>
                  <strong>{label(member.displayName)}</strong>
                  <small>{label(member.email, shortId(member.userId))}</small>
                </div>
                <StatusStamp value={label(member.role)} />
                <StatusStamp value={label(member.status)} />
                {elevated && member.role !== "owner" && member.status === "active" ? (
                  <div className="row-actions">
                    <button
                      type="button"
                      onClick={() =>
                        void command(
                          "identity.membership.role",
                          { membershipId: member.membershipId, role: member.role === "admin" ? "member" : "admin" },
                          Number(member.revision),
                        )
                      }
                    >
                      {member.role === "admin" ? "Member로" : "Admin으로"}
                    </button>
                    <button
                      className="danger"
                      type="button"
                      onClick={() =>
                        void command(
                          "identity.membership.suspend",
                          { membershipId: member.membershipId },
                          Number(member.revision),
                        )
                      }
                    >
                      중지
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
        <section className="ledger-panel">
          <div className="panel-title">
            <div>
              <p className="eyebrow">BROWSER SESSIONS</p>
              <h2>내 접속 세션</h2>
            </div>
            <span>{sessions.length}</span>
          </div>
          <div className="session-list">
            {sessions.map((session) => (
              <article key={label(session.sessionId)}>
                <div>
                  <strong>{shortId(session.sessionId)}</strong>
                  <small>최근 {label(session.lastSeenAt)}</small>
                </div>
                <StatusStamp value={label(session.status)} />
                {session.status === "active" ? (
                  <button
                    type="button"
                    className="secondary-button danger"
                    onClick={() =>
                      void command(
                        "application.session.revoke",
                        { sessionId: session.sessionId, reason: "Access Console" },
                        Number(session.revision),
                      )
                    }
                  >
                    폐기
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
