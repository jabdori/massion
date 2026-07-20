import { useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { label, list, object, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function RoomPage() {
  const { roomId } = useParams({ from: "/rooms/$roomId" });
  const snapshotData = useQueryData<unknown>(consoleStore, "organization.graph.snapshot");
  const meData = useQueryData<unknown>(consoleStore, "identity.me");
  const [content, setContent] = useState("");
  const [notice, setNotice] = useState<string>();
  const room = rows(object(snapshotData).rooms).find((candidate) => candidate.roomId === roomId);
  const workId = label(room?.workId, "");
  const messagePayload = useMemo(() => ({ workId, roomId }), [roomId, workId]);
  const messagesData = useQueryData<unknown>(consoleStore, "work.messages", messagePayload, undefined, {
    enabled: Boolean(workId),
  });
  if (snapshotData === undefined || meData === undefined || (workId && messagesData === undefined))
    return <LoadingState label="협업 대화를 불러오고 있습니다" />;
  const messageRows = rows(messagesData);
  const me = object(meData);

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!content.trim() || !workId) return;
    try {
      await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: "collaboration.message.post",
        payload: {
          workId,
          roomId,
          messageType: "text",
          authorKind: "user",
          authorId: label(me.userId),
          content: content.trim(),
        },
      });
      setContent("");
      setNotice("메시지를 보냈습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "메시지를 보내지 못했습니다.");
    }
  }

  return (
    <>
      <PageHeader
        index="COLLABORATION / ROOM"
        title={label(room?.name, "협업방")}
        description="사용자와 여러 에이전트가 같은 사건 순서 위에서 동시에 대화합니다."
      />
      <div className="room-meta">
        <StatusStamp value={label(room?.status, "unknown")} />
        <span>{list(room?.participantIds).length} participants</span>
        <code>{roomId}</code>
      </div>
      <section className="conversation" aria-label="협업 메시지">
        {messageRows.map((message) => (
          <article key={label(message.messageId)} className={`message message-${label(message.authorKind)}`}>
            <header>
              <strong>{label(message.authorId)}</strong>
              <span>#{label(message.sequence)}</span>
              <time>{label(message.createdAt)}</time>
            </header>
            <p>{label(message.content)}</p>
          </article>
        ))}
        {messageRows.length === 0 ? <p className="quiet-line">첫 메시지를 보내 협업을 시작해주세요.</p> : null}
      </section>
      <form
        className="composer"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label htmlFor="room-message">협업방에 말하기</label>
        <textarea
          id="room-message"
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
          }}
          maxLength={16_000}
          rows={3}
          placeholder="에이전트들과 공유할 내용…"
        />
        <div>
          <span role="status" aria-live="polite">
            {notice}
          </span>
          <button className="primary-button" type="submit" disabled={!workId || !content.trim()}>
            메시지 보내기
          </button>
        </div>
      </form>
    </>
  );
}
