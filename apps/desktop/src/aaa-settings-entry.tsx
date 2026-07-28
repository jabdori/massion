// 임시 확인용 진입점입니다. AAA 루프가 끝나면 aaa-settings.html과 함께 삭제합니다.
import { createRoot } from "react-dom/client";

import { createFixtureDesktopService } from "./desktop-service";
import { SettingsSurface } from "./surfaces/settings";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("루트 없음");

createRoot(root).render(
  <div className="grid h-screen grid-cols-[74px_minmax(0,1fr)] bg-canvas">
    <div className="border-r border-line-strong bg-chrome" />
    <div className="grid min-h-0 grid-cols-1">
      <SettingsSurface onEmergencyChanged={() => undefined} service={createFixtureDesktopService()} />
    </div>
  </div>,
);
