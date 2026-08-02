import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const root = new URL("../", import.meta.url);

async function source(path) {
  return await readFile(new URL(path, root), "utf8");
}

test("레거시 Web·TUI 제품 표면과 릴리스 진입점이 없다", async () => {
  for (const path of [
    "apps/web",
    "apps/tui",
    "packages/application/src/browser.ts",
    "packages/application/src/palette.ts",
    "packages/application/src/palette.test.ts",
  ]) {
    await assert.rejects(access(new URL(path, root)), { code: "ENOENT" });
  }

  const activePackageAndReleaseFiles = [
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "apps/distribution/package.json",
    "deploy/caddy/Dockerfile",
    "deploy/caddy/Caddyfile",
    "scripts/build-release.mjs",
    "scripts/install-script.test.mjs",
    "scripts/local-release-install.test.mjs",
    "scripts/release-manifest.mjs",
    "scripts/uat-subscriptions.mjs",
    "release/install.sh",
    "release/update.sh",
  ];
  const forbidden = /(?:apps\/(?:web|tui)|@massion\/(?:web|tui)|massion-tui|MASSION_WEB_ROOT)/u;

  for (const path of activePackageAndReleaseFiles) {
    assert.doesNotMatch(await source(path), forbidden, `${path}에 레거시 진입점이 남았습니다`);
  }

  const productSources = [
    "apps/cli/src/main.ts",
    "apps/cli/src/parser.ts",
    "apps/server/src/config.ts",
    "packages/application/src/access-commands.ts",
    "packages/application/src/http-server.ts",
    "packages/application/src/index.ts",
    "packages/application/src/product.ts",
    "packages/application/src/query-registry.ts",
    "packages/local-control/src/daemon.ts",
  ];
  const removedRuntime = /(?:--web|web-login|WebSession|webSessions|webRoot|MASSION_WEB_ROOT|\/api\/v1\/web)/u;
  for (const path of productSources) {
    assert.doesNotMatch(await source(path), removedRuntime, `${path}에 레거시 runtime 표면이 남았습니다`);
  }
  assert.doesNotMatch(await source("packages/application/src/index.ts"), /export \* from "\.\/palette\.js"/u);
  assert.doesNotMatch(
    (await source("packages/application/src/design-tokens.ts")).split("\n", 3).join("\n"),
    /Web|TUI/u,
  );
  for (const path of ["packages/application/src/core-pipeline.test.ts", "packages/work/src/work.test.ts"]) {
    assert.doesNotMatch(await source(path), /surface:\s*["'](?:web|tui)["']/u, `${path}에 삭제된 표면 값이 남았습니다`);
  }

  const caddy = await source("deploy/caddy/Caddyfile");
  assert.doesNotMatch(caddy, /(?:root \* \/srv|file_server|try_files)/u);
  assert.match(caddy, /@registry path \/npm\/\*/u);
  assert.match(caddy, /@connectors path \/connectors/u);
  assert.match(caddy, /@backend path \/api\/\*/u);

  for (const path of [".prettierignore", "eslint.config.js"]) {
    assert.doesNotMatch(await source(path), /apps\/(?:web|tui)/u, `${path}에 삭제된 경로가 남았습니다`);
  }

  const bunReleaseFiles = [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "apps/distribution/package.json",
    "release/install.sh",
    "release/update.sh",
    "scripts/build-release.mjs",
    "scripts/release-manifest.mjs",
    "scripts/uat-subscriptions.mjs",
  ];
  for (const path of bunReleaseFiles) {
    assert.doesNotMatch(
      await source(path),
      /(?:\bBun\b|\bbun\b|setup-bun|MASSION_BUN_VERSION)/u,
      `${path}에 TUI 전용 Bun 계약이 남았습니다`,
    );
  }

  const currentDocs = [
    "README.md",
    "PRODUCT.md",
    "apps/desktop/README.md",
    "docs/architecture/README.md",
    "docs/architecture/desktop-clean-sheet.md",
    "CHANGELOG.md",
    "docs/operations/local-install.md",
    "docs/operations/self-hosting-install.md",
    "docs/operations/upgrade-rollback.md",
    "docs/phases/30-surface-parity-agent-ux/v1-delivery/README.md",
    "apps/desktop/src-tauri/RELEASE.md",
  ];
  for (const path of currentDocs) {
    const content = await source(path);
    assert.doesNotMatch(content, /(?:제거 예정.{0,40}(?:TUI|Web)|(?:TUI|Web).{0,40}제거 예정)/u);
    assert.doesNotMatch(content, /(?:CLI·TUI·Web 설치 묶음|레거시 CLI·TUI·Web 묶음|HTTPS readiness, Web\/API)/u);
  }
});
