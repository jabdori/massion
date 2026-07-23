import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");
const ignoredDirectories = new Set(["dist", "gen", "node_modules", "target"]);
const inspectedExtensions = new Set([".css", ".html", ".js", ".json", ".jsx", ".mjs", ".rs", ".toml", ".ts", ".tsx"]);

async function listTextFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTextFiles(absolutePath)));
    else if (inspectedExtensions.has(path.extname(entry.name))) files.push(absolutePath);
  }

  return files;
}

test("데스크톱은 폐기 대상 UI와 원격 웹 래퍼·범용 시스템 권한에 의존하지 않는다", async () => {
  const violations = [];
  const files = await listTextFiles(desktop);

  for (const file of files) {
    const relativePath = path.relative(root, file);
    const source = await readFile(file, "utf8");

    if (
      /(?:apps\/(?:web|studio|tui)\b|@massion\/(?:web|studio|tui)\b|\.\.\/(?:\.\.\/)*(?:web|studio|tui)(?:\/|["']))/u.test(
        source,
      )
    ) {
      violations.push(`${relativePath}: 폐기 대상 UI 참조`);
    }
    if (/WebviewUrl::External|https?:\/\/(?:127\.0\.0\.1|localhost)(?=[:/"'])|document\.cookie/u.test(source)) {
      violations.push(`${relativePath}: 원격 로컬 웹 래퍼 패턴`);
    }
  }

  const tauriConfigPath = path.join(desktop, "src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
  if (tauriConfig.app?.withGlobalTauri === true)
    violations.push("apps/desktop/src-tauri/tauri.conf.json: withGlobalTauri=true");
  if (tauriConfig.app?.security?.csp == null || tauriConfig.app.security.csp === "") {
    violations.push("apps/desktop/src-tauri/tauri.conf.json: CSP 미설정");
  }
  if (!Array.isArray(tauriConfig.app?.security?.capabilities) || tauriConfig.app.security.capabilities.length === 0) {
    violations.push("apps/desktop/src-tauri/tauri.conf.json: 명시적 capability allowlist 없음");
  }
  if (
    tauriConfig.build?.frontendDist === "../fallback" ||
    /^https?:\/\//u.test(tauriConfig.build?.frontendDist ?? "")
  ) {
    violations.push("apps/desktop/src-tauri/tauri.conf.json: 독립 렌더러가 아닌 frontendDist");
  }

  const capabilitiesDirectory = path.join(desktop, "src-tauri/capabilities");
  for (const entry of await readdir(capabilitiesDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".json") continue;
    const relativePath = path.join("apps/desktop/src-tauri/capabilities", entry.name);
    const capability = JSON.parse(await readFile(path.join(capabilitiesDirectory, entry.name), "utf8"));
    if (capability.remote != null) violations.push(`${relativePath}: remote URL scope`);
    for (const permission of capability.permissions ?? []) {
      const identifier = typeof permission === "string" ? permission : permission?.identifier;
      if (typeof identifier === "string" && /^(?:shell|fs):/u.test(identifier)) {
        violations.push(`${relativePath}: 범용 ${identifier.split(":", 1)[0]} 권한(${identifier})`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
