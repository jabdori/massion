import { Link, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { label, list, object, rows } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function WorkPage() {
  const { workId } = useParams({ from: "/works/$workId" });
  const payload = useMemo(() => ({ workId }), [workId]);
  const workData = useQueryData<unknown>(consoleStore, "work.get", payload);
  const tasksData = useQueryData<unknown>(consoleStore, "work.tasks", payload);
  const assignmentsData = useQueryData<unknown>(consoleStore, "work.assignments", payload);
  const roomsData = useQueryData<unknown>(consoleStore, "work.rooms", payload);
  const recordsData = useQueryData<unknown>(consoleStore, "work.records", payload);
  const [notice, setNotice] = useState<string>();
  if ([workData, tasksData, assignmentsData, roomsData].some((value) => value === undefined))
    return <LoadingState label="업무 원장을 조립하고 있습니다" />;
  const work = object(workData);
  const tasks = rows(tasksData);
  const assignments = rows(assignmentsData);
  const rooms = rows(roomsData);
  const records = rows(recordsData);

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

  return (
    <>
      <PageHeader
        index="WORK / DETAIL"
        title={`업무 ${label(workId).slice(0, 12)}`}
        description="Task, 배정, 협업방과 최종 기록의 한 흐름을 추적합니다."
        action={
          <button
            className="secondary-button danger"
            type="button"
            onClick={() => void cancel()}
            disabled={["cancelled", "completed"].includes(label(work.status))}
          >
            업무 취소
          </button>
        }
      />
      <div className="live-notice" role="status">
        {notice ?? `현재 revision ${label(work.revision, "0")}`}
      </div>
      <section className="work-status-band">
        <StatusStamp value={label(work.status)} />
        <span>REV {label(work.revision)}</span>
        <span>ARTIFACT {list(work.artifactIds).length}</span>
      </section>
      <div className="work-layout">
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
          <section className="ledger-panel">
            <div className="panel-title">
              <div>
                <p className="eyebrow">FINAL RECORDS</p>
                <h2>완료 기록</h2>
              </div>
            </div>
            {records.map((record) => (
              <article className="record-line" key={label(record.recordId)}>
                <strong>V{label(record.version)}</strong>
                <span>{label(record.summary)}</span>
              </article>
            ))}
            {records.length === 0 ? <p className="quiet-line">아직 확정된 기록이 없습니다.</p> : null}
          </section>
        </aside>
      </div>
    </>
  );
}
