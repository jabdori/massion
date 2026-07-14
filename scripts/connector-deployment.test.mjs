import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";

const root = new URL("../", import.meta.url);

async function source(path) {
  return await readFile(new URL(path, root), "utf8");
}

function between(value, start, end) {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `${start.trim()} 시작 지점을 찾지 못했습니다`);
  const contentStart = startIndex + start.length;
  const endIndex = value.indexOf(end, contentStart);
  assert.notEqual(endIndex, -1, `${end.trim()} 종료 지점을 찾지 못했습니다`);
  return value.slice(contentStart, endIndex);
}

test("Caddy가 정확한 연결 장치 WebSocket 경로를 API 서버로 전달한다", async () => {
  const caddy = await source("deploy/caddy/Caddyfile");
  const connectorStart = caddy.indexOf("\t@connectors path /connectors\n");
  const backendStart = caddy.indexOf("\t@backend path ");
  const fallbackStart = caddy.indexOf("\troot * /srv\n");

  assert.notEqual(connectorStart, -1, "정확한 /connectors matcher가 필요합니다");
  assert.ok(connectorStart < backendStart, "연결 장치 경로는 일반 API 경로보다 먼저 처리해야 합니다");
  assert.ok(connectorStart < fallbackStart, "연결 장치 경로가 정적 웹 fallback에 도달하면 안 됩니다");

  const connector = caddy.slice(connectorStart, backendStart);
  assert.match(connector, /handle @connectors/u);
  assert.match(connector, /reverse_proxy \{\$MASSION_UPSTREAM:massion:3141\}/u);
  assert.match(connector, /header_up X-Forwarded-Proto https/u);
  assert.doesNotMatch(connector, /header_up (?:Connection|Upgrade)/iu);
});

test("Docker Compose 팀 배포가 영속 연결 장치 root와 안전한 수신 기본값을 전달한다", async () => {
  const compose = await source("compose.yaml");
  const massion = between(compose, "\n  massion:\n", "\n  caddy:\n");

  assert.match(massion, /MASSION_CONNECTOR_ROOT: \/var\/lib\/massion\/connectors/u);
  assert.match(massion, /MASSION_CONNECTOR_EXECUTABLES: ['"]\{\}['"]/u);
  assert.match(massion, /MASSION_EDGE_CONNECTOR_ENABLED: "\$\{MASSION_EDGE_CONNECTOR_ENABLED:-true\}"/u);
  assert.match(massion, /MASSION_CONNECTOR_HEARTBEAT_MS: "\$\{MASSION_CONNECTOR_HEARTBEAT_MS:-30000\}"/u);
  assert.match(massion, /massion-data:\/var\/lib\/massion/u);
});

test("Docker volume-init은 기존 0700 하위 directory를 재귀 순회하지 않고 재기동에 멱등이다", async () => {
  const compose = await source("compose.yaml");
  const volumeInit = between(compose, "\n  volume-init:\n", "\n  surrealdb:\n");

  assert.match(volumeInit, /chown 1000:1000 \/backups \/var\/lib\/massion/u);
  assert.match(volumeInit, /chmod 0700 \/backups \/var\/lib\/massion/u);
  assert.doesNotMatch(volumeInit, /chown -R/u);
});

test("Docker restore는 runtime API container가 아닌 owner provisioning container에서 실행할 수 있다", async () => {
  const compose = await source("compose.yaml");
  const provision = between(compose, "\n  database-provision:\n", "\n  massion:\n");

  assert.match(provision, /backup-data:\/backups/u);
  assert.match(provision, /MASSION_DATABASE_PROVISION_PASSWORD_FILE/u);
});

test("Kubernetes 팀 배포가 같은 연결 장치 설정을 ConfigMap으로 전달한다", async () => {
  const configMap = await source("deploy/kubernetes/base/configmap.yaml");

  assert.match(configMap, /MASSION_CONNECTOR_ROOT: \/var\/lib\/massion\/connectors/u);
  assert.match(configMap, /MASSION_CONNECTOR_EXECUTABLES: ['"]\{\}['"]/u);
  assert.match(configMap, /MASSION_EDGE_CONNECTOR_ENABLED: "true"/u);
  assert.match(configMap, /MASSION_CONNECTOR_HEARTBEAT_MS: "30000"/u);
});
