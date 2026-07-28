// 임시 확인용 진입점입니다. AAA 루프가 끝나면 aaa-growth.html과 함께 삭제합니다.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { createFixtureDesktopService, type GrowthView } from "./desktop-service";
import { GrowthSurface } from "./surfaces/growth";
import "./styles.css";

const service = createFixtureDesktopService();

function Harness() {
  const [growth, setGrowth] = useState<GrowthView>();
  useEffect(() => {
    void service.loadGrowth().then(setGrowth);
  }, []);
  return (
    <GrowthSurface
      error=""
      growth={growth}
      onOpenWork={() => undefined}
      onRetry={() => undefined}
      requestedSuggestionId={undefined}
      service={service}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("루트 없음");

createRoot(root).render(
  <div className="app-shell grid grid-cols-[150px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-canvas text-primary">
    <div className="border-r border-line-strong bg-chrome" />
    <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)]">
      <Harness />
    </div>
  </div>,
);
