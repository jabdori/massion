import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
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
