// Solid JSX(.tsx)를 포함한 TUI를 단일 dist/main.js로 번들합니다.
// 패키지 의존성은 external로 유지해 릴리스 node_modules 배치를 그대로 사용합니다.
import { rmSync } from "node:fs";

import solidTransformPlugin from "@opentui/solid/bun-plugin";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "dist",
  target: "bun",
  packages: "external",
  plugins: [solidTransformPlugin],
  sourcemap: "external",
});

if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  process.exit(1);
}
console.log(`TUI dist 번들 완료: ${String(result.outputs.length)}개 파일`);
