import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { createApplicationDesktopService, createFixtureDesktopService } from "./desktop-service";
import { createTauriNativeTransport, isTauriRuntime } from "./native-transport";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("앱 루트 요소를 찾을 수 없습니다.");

// 브라우저 개발 화면만 명시적 fixture를 사용합니다. Tauri에서는 연결 실패를 숨기지 않습니다.
const service = isTauriRuntime()
  ? createApplicationDesktopService(createTauriNativeTransport())
  : createFixtureDesktopService();

createRoot(root).render(
  <StrictMode>
    <App service={service} />
  </StrictMode>,
);
