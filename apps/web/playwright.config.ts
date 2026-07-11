import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:4173", colorScheme: "dark", locale: "ko-KR", trace: "retain-on-failure" },
  projects: [
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 360, height: 800 } } },
    { name: "tablet", use: { browserName: "chromium", viewport: { width: 768, height: 1024 } } },
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: "pnpm dev", url: "http://127.0.0.1:4173", reuseExistingServer: false, timeout: 30_000 },
});
