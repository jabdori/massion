// Solid JSX(.tsx)를 포함한 TUI를 단일 dist/main.js로 번들합니다.
// 패키지 의존성은 external로 유지해 릴리스 node_modules 배치를 그대로 사용합니다.
import { rmSync, writeFileSync } from "node:fs";

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

// @opentui/solid의 reactivity 셋업(preload)은 번들보다 먼저 실행돼야 합니다. bunfig.toml의
// preload는 개발/테스트에서만 적용되므로, 배포에서는 launcher가 `bun --preload dist/preload.mjs`로
// 이 진입점을 먼저 로드합니다. 경로가 안정적이도록 dist 안에 고정 파일로 emit합니다.
writeFileSync("dist/preload.mjs", 'import "@opentui/solid/preload";\n');

console.log(`TUI dist 번들 완료: ${String(result.outputs.length + 1)}개 파일`);
