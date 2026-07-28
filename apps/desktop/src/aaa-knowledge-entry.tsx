// 임시 확인용 진입점입니다. AAA 루프가 끝나면 aaa-knowledge.html과 함께 삭제합니다.
import { createRoot } from "react-dom/client";

import { createFixtureDesktopService } from "./desktop-service";
import { KnowledgeSurface } from "./surfaces/knowledge";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("루트 없음");

// 실제 셸(app.tsx)의 1440px 이상 격자를 그대로 흉내 냅니다.
createRoot(root).render(
  <div className="grid h-screen grid-cols-[150px_264px_minmax(0,1fr)_332px] bg-canvas">
    <div className="border-r border-line-strong bg-chrome" />
    <KnowledgeSurface onOpenWork={() => undefined} service={createFixtureDesktopService()} />
  </div>,
);
