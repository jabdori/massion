import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-actual",
  outputDir: "./test-results-actual",
  reporter: "line",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
  },
  webServer: [
    {
      command: "pnpm --filter @massion/application build && node --experimental-strip-types e2e-actual/server.ts",
      url: "http://127.0.0.1:17777/api/v1/status",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "MASSION_API_URL=http://127.0.0.1:17777 pnpm exec vite --port 4174",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
