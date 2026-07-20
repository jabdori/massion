import { Link, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { USER_STAGES, userStageForInternal, userStageProgress, workStatusToken } from "@massion/application";

import { label, list, object, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, StatusStamp } from "../components/States.js";

// work 객체에는 stage 필드가 없으므로 status에서 내부 단계를 유추합니다.
function internalStageFromWorkStatus(status: string): string {
  switch (status) {
    case "ready":
      return "intake";
    case "running":
    case "awaiting-approval":
    case "blocked":
    case "failed":
      return "delivery";
    case "completed":
    case "cancelled":
      return "records";
    default:
      return "intake";
  }
}

export default function WorkPage() {
  const { workId } = useParams({ from: "/works/$workId" });
  const payload = useMemo(() => ({ workId }), [workId]);
  const workData = useQueryData<unknown>(consoleStore, "work.get", payload);
  const tasksData = useQueryData<unknown>(consoleStore, "work.tasks", payload);
  const assignmentsData = useQueryData<unknown>(consoleStore, "work.assignments", payload);
  const roomsData = useQueryData<unknown>(consoleStore, "work.rooms", payload);
  const recordsData = useQueryData<unknown>(consoleStore, "work.records", payload);
  const meData = useQueryData<unknown>(consoleStore, "identity.me");
  const [notice, setNotice] = useState<string>();
  const [messageText, setMessageText] = useState("");
  const [messageNotice, setMessageNotice] = useState<string>();
  const [showDetails, setShowDetails] = useState(false);

  if ([workData, tasksData, assignmentsData, roomsData, meData].some((value) => value === undefined))
    return <LoadingState label="업무 정보를 불러오고 있습니다" />;

  const work = object(workData);
  const tasks = rows(tasksData);
  const assignments = rows(assignmentsData);
  const rooms = rows(roomsData);
  const records = rows(recordsData);
  const me = object(meData);
  const firstRoomId = label(rooms[0]?.roomId, "");
  const messagesPayload = useMemo(
    () => ({ workId, roomId: firstRoomId }),
    [workId, firstRoomId],
  );
  const messagesData = useQueryData<unknown>(consoleStore, "work.messages", messagesPayload, undefined, {
    enabled: Boolean(firstRoomId),
  });
  const messages = rows(messagesData);

  const workStatus = label(work.status);
  const statusToken = workStatusToken(workStatus);
  const internalStage = internalStageFromWorkStatus(workStatus);
  const currentStage = userStageForInternal(internalStage);

  async function cancel() {
    try {
      await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: "work.cancel",
        expectedRevision: Number(work.revision),
        payload: { workId },
      });
      await consoleStore.refresh("work.get", payload);
      setNotice("업무 취소 요청을 반영했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "취소하지 못했습니다.");
    }
  }

  async function sendMessage(event: { preventDefault(): void }) {
    event.preventDefault();
    const text = messageText.trim();
    if (!text || !firstRoomId) return;
    try {
      await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: "collaboration.message.post",
        payload: {
          workId,
          roomId: firstRoomId,
          messageType: "question",
          authorKind: "user",
          authorId: label(me.userId),
          content: text,
        },
      });
      setMessageText("");
      setMessageNotice("메시지를 보냈습니다.");
      await consoleStore.refresh("work.messages", messagesPayload);
    } catch (error) {
      setMessageNotice(error instanceof Error ? error.message : "메시지를 보내지 못했습니다.");
    }
  }

  return (
    <>
      {/* 친화적 헤더: 현재 단계와 상태를 사용자 언어로 표시 */}
      <section className="greeting-section">
        <h1>{currentStage.friendlyLabel}</h1>
        <span className={`friendly-status is-${statusToken.semantic}`}>
          <span className="status-symbol">{statusToken.symbol}</span>
          {statusToken.friendlyLabel}
        </span>
      </section>

      <div className="live-notice" role="status">
        {notice ?? `${currentStage.friendlyLabel} 단계입니다. ${statusToken.friendlyLabel}.`}
      </div>

      {/* 사용자용 4단계 진행 바 */}
      <div className="stage-progress">
        {USER_STAGES.map((stage, index) => {
          const progress = userStageProgress(internalStage, stage.id);
          return (
            <div key={stage.id} className={`stage-step ${progress}`}>
              <span className="stage-step-dot">{progress === "completed" ? "✓" : index + 1}</span>
              <span className="stage-step-label">{stage.friendlyLabel}</span>
            </div>
          );
        })}
      </div>

      {/* 최근 소식: 작업 목록을 친화적 카드로 */}
      <section className="home-section" style={{ marginTop: "32px" }}>
        <h2 className="home-section-title">최근 소식</h2>
        {tasks.length === 0 ? (
          <p className="quiet-line">아직 진행된 작업이 없습니다. 계획이 완료되면 작업이 생성됩니다.</p>
        ) : (
          <div className="card-list">
            {tasks.slice(0, 6).map((task) => {
              const assignment = assignments.find((item) => item.taskId === task.taskId);
              return (
                <article className="work-card" key={label(task.taskId)}>
                  <div className="work-card-header">
                    <StatusStamp value={label(task.status)} />
                  </div>
                  <p className="work-card-title">{label(task.title)}</p>
                  {assignment ? (
                    <span className="work-card-label">@{label(assignment.agentHandle)}</span>
                  ) : (
                    <span className="work-card-label">담당자 대기 중</span>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* 결과물 */}
      <section className="home-section">
        <h2 className="home-section-title">결과물</h2>
        {records.length === 0 ? (
          <p className="quiet-line">아직 확정된 결과물이 없습니다.</p>
        ) : (
          <div className="card-list">
            {records.map((record) => (
              <article className="recent-result" key={label(record.recordId)}>
                <span className="recent-result-symbol">✓</span>
                <span className="recent-result-title">{label(record.summary)}</span>
                <span className="recent-result-meta">V{label(record.version)}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Massion에게 메시지 보내기 */}
      {firstRoomId ? (
        <section className="home-section">
          <h2 className="home-section-title">Massion에게 메시지 보내기</h2>
          <form className="composer-inline" onSubmit={(event) => { void sendMessage(event); }}>
            <textarea
              value={messageText}
              onChange={(event) => { setMessageText(event.target.value); }}
              maxLength={16_000}
              rows={2}
              placeholder="작업에 대해 질문이나 추가 지시를 입력하세요…"
              aria-label="Massion에게 보낼 메시지"
            />
            <div className="composer-inline-actions">
              <span role="status" aria-live="polite">{messageNotice}</span>
              <button className="primary-button" type="submit" disabled={!messageText.trim()}>
                메시지 보내기
              </button>
            </div>
          </form>
          {messages.length > 0 ? (
            <div className="message-preview-list">
              {messages.slice(-5).map((message) => (
                <article key={label(message.messageId)} className={`message message-${label(message.authorKind)}`}>
                  <header>
                    <strong>{label(message.authorId)}</strong>
                    <time>{label(message.createdAt)}</time>
                  </header>
                  <p>{label(message.content)}</p>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* 업무 취소 */}
      {!["cancelled", "completed"].includes(workStatus) ? (
        <div style={{ marginTop: "16px" }}>
          <button className="secondary-button danger" type="button" onClick={() => void cancel()}>
            업무 취소
          </button>
        </div>
      ) : null}

      {/* 자세히 보기 토글 */}
      <div style={{ marginTop: "24px" }}>
        <button
          className="details-toggle"
          aria-expanded={showDetails}
          onClick={() => { setShowDetails(!showDetails); }}
        >
          자세히 보기
        </button>
      </div>

      {/* 기술 정보 (토글로 펼침) */}
      {showDetails ? (
        <div className="work-detail">
          <section className="work-status-band">
            <StatusStamp value={workStatus} />
            <span>REV {label(work.revision)}</span>
            <span>ARTIFACT {list(work.artifactIds).length}</span>
            <code>{label(workId).slice(0, 12)}</code>
          </section>
          <div className="work-layout" style={{ marginTop: "16px" }}>
            <section className="ledger-panel">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">TASK REGISTER</p>
                  <h2>작업과 배정</h2>
                </div>
                <span>{tasks.length}</span>
              </div>
              {tasks.length === 0 ? (
                <EmptyState title="아직 작업이 없습니다" detail="계획 단계가 완료되면 작업이 생성됩니다." />
              ) : (
                <div className="task-list">
                  {tasks.map((task) => {
                    const assignment = assignments.find((item) => item.taskId === task.taskId);
                    return (
                      <article key={label(task.taskId)}>
                        <div>
                          <strong>{label(task.title)}</strong>
                          <code>{label(task.taskId)}</code>
                        </div>
                        <StatusStamp value={label(task.status)} />
                        <span>{assignment ? `@${label(assignment.agentHandle)}` : "미배정"}</span>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
            <aside className="work-side">
              <section className="ledger-panel">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">COLLABORATION</p>
                    <h2>협업방</h2>
                  </div>
                </div>
                {rooms.map((room) => (
                  <Link
                    key={label(room.roomId)}
                    to="/rooms/$roomId"
                    params={{ roomId: label(room.roomId) }}
                    className="room-link"
                  >
                    <strong>{label(room.name)}</strong>
                    <span>{label(room.lastMessageSequence, "0")} messages</span>
                  </Link>
                ))}
                {rooms.length === 0 ? <p className="quiet-line">열린 협업방이 없습니다.</p> : null}
              </section>
            </aside>
          </div>
        </div>
      ) : null}
    </>
  );
}
