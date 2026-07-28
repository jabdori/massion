// 임시 미리보기 진입점. 홈 표면만 렌더해 스크린샷을 찍기 위한 것이며 커밋하지 않습니다.
import { createRoot } from "react-dom/client";

import { createFixtureDesktopService } from "./desktop-service";
import type { ApprovalView, InboxItem, WorkView } from "./model";
import { HomeSurface } from "./surfaces/home";
import "./styles.css";
import { useEffect, useState } from "react";

const service = createFixtureDesktopService();

function buildInboxItems(approvals: ApprovalView[], works: readonly WorkView[], suggestions: readonly { suggestionId: string; workId: string; summary: string; rationale: string; status: string }[]): InboxItem[] {
  const blocked: InboxItem[] = works
    .filter((work) => work.run?.status === "blocked")
    .map((work) => ({ kind: "blocked", id: `blocked:${work.id}`, workId: work.id, title: work.title, reason: work.run?.blockedReason ?? "차단됨" }));
  const approval: InboxItem[] = approvals.map((item) => ({ kind: "approval", id: item.id, approval: item }));
  const growth: InboxItem[] = suggestions
    .filter((suggestion) => suggestion.status === "awaiting-review")
    .map((suggestion) => ({ kind: "growth", id: `growth:${suggestion.suggestionId}`, suggestionId: suggestion.suggestionId, workId: suggestion.workId, title: suggestion.summary, reason: suggestion.rationale }));
  return [...blocked, ...approval, ...growth];
}

function Preview() {
  const [items, setItems] = useState<InboxItem[]>();
  useEffect(() => {
    void Promise.all([service.loadPendingApprovals(), service.loadIndex({ filter: "active", search: "" }), service.loadGrowth()]).then(
      ([approvals, works, growth]) => {
        setItems(buildInboxItems(approvals.filter((item) => item.status === "pending"), works, growth.suggestions));
      },
    );
  }, []);
  return (
    <div
      className="app-shell grid min-h-[720px] min-w-[1180px] grid-cols-[150px_242px_minmax(420px,1fr)_300px] grid-rows-[minmax(0,1fr)] overflow-hidden bg-canvas text-primary min-[1440px]:grid-cols-[150px_264px_minmax(0,1fr)_332px]"
    >
      <div className="border-r-[0.5px] border-line-strong bg-bg-1" />
      <HomeSurface
        inboxItems={items}
        onCreate={() => undefined}
        onOpenNotifications={() => undefined}
        onOpenWork={() => undefined}
        service={service}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
