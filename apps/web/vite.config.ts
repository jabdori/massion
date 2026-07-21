import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 웹은 브라우저 안전 진입점만 사용합니다.
      // @massion/application의 barrel export가 서버 전용 패키지(surrealdb, tar 등)를
      // 끌어들이는 것을 방지하기 위해 browser.ts 소스를 직접 가리킵니다.
      "@massion/application": resolve(__dirname, "../../packages/application/src/browser.ts"),
      // nimbalyst 렌더러(vendor) — 번들링은 vendor 소스를 직접 사용합니다.
      // 디렉토리를 가리켜 bare(@nimbalyst/runtime)와 subpath(@nimbalyst/runtime/ui)를 모두 해결합니다.
      // 타입검사는 tsconfig.vendor.json(완화 설정)에서 별도 처리합니다.
      "@nimbalyst/runtime": resolve(__dirname, "src/vendor/nimbalyst"),
      "@nimbalyst/extension-sdk": resolve(__dirname, "src/vendor/nimbalyst-extension-sdk"),
      "@nimbalyst/collab-protocol": resolve(__dirname, "src/vendor/nimbalyst-collab-protocol"),
      "@nimbalyst/collab-adapters": resolve(__dirname, "src/vendor/nimbalyst-collab-adapters"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: { "/api": { target: process.env.MASSION_API_URL ?? "http://127.0.0.1:7777" } },
  },
  preview: { host: "127.0.0.1", port: 4173 },
  build: {
    target: "es2024",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/react/") || id.includes("/react-dom/")) return "react";
          if (id.includes("/@tanstack/react-router/")) return "router";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
