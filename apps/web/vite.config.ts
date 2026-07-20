import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 웹은 design-tokens만 필요합니다.
      // @massion/application의 barrel export가 서버 전용 패키지(surrealdb, tar 등)를
      // 끌어들이는 것을 방지하기 위해 design-tokens 소스를 직접 가리킵니다.
      "@massion/application": resolve(__dirname, "../../packages/application/src/design-tokens.ts"),
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
