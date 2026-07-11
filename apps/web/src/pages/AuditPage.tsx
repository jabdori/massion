import { useMemo, useState } from "react";

import { label, object, rows, shortId } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function AuditPage() {
  const data = useQueryData<unknown>(consoleStore, "application.audit", { limit: 500 });
  const [filter, setFilter] = useState("");
  const events = rows(object(data).events);
  const filtered = useMemo(
    () => events.filter((event) => JSON.stringify(event).toLowerCase().includes(filter.toLowerCase())),
    [events, filter],
  );
  if (data === undefined) return <LoadingState label="변경 원장을 검증하고 있습니다" />;
  return (
    <>
      <PageHeader
        index="04 / AUDIT LEDGER"
        title="무엇이, 왜, 어떤 순서로 바뀌었나요?"
        description="전역 사건 순서와 작성자·인과관계·대상 자원을 변경 불가능한 원장처럼 탐색합니다."
        action={
          <label className="filter-field">
            <span>원장 검색</span>
            <input
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
              }}
              type="search"
              placeholder="작업, 에이전트, 사건…"
            />
          </label>
        }
      />
      <section className="audit-ledger" aria-label="감사 사건 목록">
        <div className="audit-head">
          <span>SEQ</span>
          <span>사건</span>
          <span>작성자</span>
          <span>대상</span>
          <span>시각</span>
        </div>
        {filtered.map((event) => {
          const author = object(event.author);
          const resource = object(event.resource);
          return (
            <article key={label(event.sequence)} className="audit-row">
              <strong>{label(event.sequence).padStart(6, "0")}</strong>
              <div>
                <StatusStamp value={label(event.type)} />
                <small>{shortId(event.eventId)}</small>
              </div>
              <span>
                {label(author.kind)} / {shortId(author.id)}
              </span>
              <span>
                {label(resource.type)} {shortId(resource.id)}
              </span>
              <time>{label(event.occurredAt)}</time>
            </article>
          );
        })}
        {filtered.length === 0 ? <p className="quiet-line">조건에 맞는 사건이 없습니다.</p> : null}
      </section>
    </>
  );
}
