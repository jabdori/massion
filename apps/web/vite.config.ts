import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // 웹은 브라우저 안전 진입점만 사용합니다.
      // @massion/application의 barrel export가 서버 전용 패키지(surrealdb, tar 등)를
      // 끌어들이는 것을 방지하기 위해 browser.ts 소스를 직접 가리킵니다.
      { find: "@massion/application", replacement: resolve(__dirname, "../../packages/application/src/browser.ts") },
      // nimbalyst 렌더러(vendor) — 번들링은 vendor 소스를 직접 사용합니다.
      // 디렉토리를 가리켜 bare(@nimbalyst/runtime)와 subpath(@nimbalyst/runtime/ui)를 모두 해결합니다.
      // 타입검사는 tsconfig.vendor.json(완화 설정)에서 별도 처리합니다.
      { find: "@nimbalyst/runtime", replacement: resolve(__dirname, "src/vendor/nimbalyst") },
      { find: "@nimbalyst/extension-sdk", replacement: resolve(__dirname, "src/vendor/nimbalyst-extension-sdk") },
      { find: "@nimbalyst/collab-protocol", replacement: resolve(__dirname, "src/vendor/nimbalyst-collab-protocol") },
      { find: "@nimbalyst/collab-adapters", replacement: resolve(__dirname, "src/vendor/nimbalyst-collab-adapters") },
      // react-syntax-highlighter의 bare import(전체 277개 언어)만 shim 으로 가로챕니다.
      // 정규식 exact match 로 deep import(dist/esm/...)는 가로채지 않습니다(shim 내부에서 씀).
      {
        find: /^react-syntax-highlighter$/,
        replacement: resolve(__dirname, "src/nimbalyst/shims/react-syntax-highlighter.ts"),
      },
    ],
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
          // nimbalyst MarkdownRenderer 가 끌어오는 무거운 렌더 자산을 별도 청크로 분리합니다.
          // react-syntax-highlighter(Prism + 언어 정의)·refractor·jotai 가 WorkPage 청크를 부풀리지 않게.
          if (
            id.includes("/react-syntax-highlighter/") ||
            id.includes("/refractor/") ||
            id.includes("/prismjs/") ||
            id.includes("/jotai/")
          )
            return "markdown-render";
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
