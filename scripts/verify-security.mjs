import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_DEPLOYMENT_MARKERS = {
  dockerfile: ["USER node", "dumb-init", "HEALTHCHECK"],
  compose: [
    "read_only: true",
    "no-new-privileges:true",
    "cap_drop:",
    "- ALL",
    "MASSION_REGISTRY_KEY_FILE",
    "database-provision:",
    "MASSION_DATABASE_PROVISION_PASSWORD_FILE",
    "MASSION_DATABASE_USER: massion_runtime",
  ],
  kubernetes: [
    "runAsNonRoot: true",
    "readOnlyRootFilesystem: true",
    "allowPrivilegeEscalation: false",
    "type: RuntimeDefault",
    "automountServiceAccountToken: false",
    "name: provision-database",
    "name: provision-secrets",
    "name: app-secrets",
    "name: tls-secrets",
  ],
  caddy: ["@registry path /npm/*", "MASSION_REGISTRY_UPSTREAM"],
};

export function assertAuditReport(report) {
  const vulnerabilities = report?.metadata?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object")
    throw new Error("production audit report 구조가 유효하지 않습니다");
  for (const severity of ["moderate", "high", "critical"]) {
    const count = vulnerabilities[severity];
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${severity} audit 수치가 유효하지 않습니다`);
    if (count > 0) throw new Error(`${severity} production advisory ${String(count)}건이 남아 있습니다`);
  }
  return vulnerabilities;
}

export function assertDeploymentSecurity(files) {
  for (const [name, markers] of Object.entries(REQUIRED_DEPLOYMENT_MARKERS)) {
    const content = files[name];
    if (typeof content !== "string") throw new Error(`${name} 보안 검사 입력이 없습니다`);
    const missing = markers.find((marker) => !content.includes(marker));
    if (missing) throw new Error(`${name === "dockerfile" ? "Dockerfile" : name}에 보안 설정이 없습니다: ${missing}`);
  }
}

async function filesUnder(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(child)));
    else result.push(child);
  }
  return result;
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
  if (!options.allowFailure && result.status !== 0)
    throw new Error(`${command} ${arguments_.join(" ")} 검증이 실패했습니다`);
  return result;
}

async function main() {
  const root = resolve(fileURLToPath(new globalThis.URL("..", import.meta.url)));
  const candidates = (await filesUnder(root))
    .filter((path) => /(?:security|auth|sandbox|provenance|oauth)\.test\.ts$/u.test(path))
    .map((path) => path.slice(root.length + 1))
    .sort();
  if (candidates.length < 10) throw new Error("보안 test suite가 예상보다 적습니다");
  run("pnpm", ["exec", "vitest", "run", ...candidates]);

  const audit = run("pnpm", ["audit", "--prod", "--json"], { capture: true, allowFailure: true });
  if (!audit.stdout) throw new Error("production audit report를 생성하지 못했습니다");
  const vulnerabilities = assertAuditReport(JSON.parse(audit.stdout));

  assertDeploymentSecurity({
    dockerfile: await readFile(resolve(root, "Dockerfile"), "utf8"),
    compose: await readFile(resolve(root, "compose.yaml"), "utf8"),
    kubernetes: await readFile(resolve(root, "deploy/kubernetes/base/massion-deployment.yaml"), "utf8"),
    caddy: await readFile(resolve(root, "deploy/caddy/Caddyfile"), "utf8"),
  });
  process.stdout.write(
    `보안 게이트 통과: ${String(candidates.length)}개 test file, moderate/high/critical 0, low ${String(vulnerabilities.low ?? 0)}\n`,
  );
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) await main();
