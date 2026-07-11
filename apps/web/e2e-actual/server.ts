import { randomBytes, randomUUID } from "node:crypto";

import { ApplicationProduct } from "@massion/application";
import { ExtensionStore } from "@massion/extension-host";
import { GOVERNANCE_APPROVAL_MIGRATION, PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { applyMigrations, createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

const remoteUrl = process.env.SURREAL_TEST_URL;
if (!remoteUrl) throw new Error("SURREAL_TEST_URL이 필요합니다");
const databaseName = `web_actual_${randomUUID().replaceAll("-", "")}`;
const sqlUrl = remoteUrl
  .replace(/^ws:/u, "http:")
  .replace(/^wss:/u, "https:")
  .replace(/\/rpc$/u, "/sql");
const provisioned = await fetch(sqlUrl, {
  method: "POST",
  headers: {
    authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
    accept: "application/json",
    "content-type": "text/plain",
  },
  body: `DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS ${databaseName};`,
});
if (!provisioned.ok) throw new Error(`실제 Web E2E database 생성 실패: ${String(provisioned.status)}`);
const database = await createDatabase({
  url: remoteUrl,
  namespace: "massion",
  database: databaseName,
  authentication: { username: "root", password: "root" },
});
const identities = await IdentityService.create(database);
const organizations = await OrganizationService.create(database);
const graph = await OrganizationGraphService.create(database, organizations);
const policies = await PolicyStore.create(database, organizations);
const works = await WorkService.create(database, organizations, graph);
await RuntimeExecutionStore.create(database, organizations);
await ExtensionStore.create(database, organizations);
await applyMigrations(database, [GOVERNANCE_APPROVAL_MIGRATION]);
const stages = ["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const;
const executors = Object.fromEntries(
  stages.map((stage) => [
    stage,
    {
      execute: () =>
        Promise.resolve(stage === "intake" ? { outcome: "advanced", workId: randomUUID() } : { outcome: "advanced" }),
    },
  ]),
);
const product = await ApplicationProduct.create({
  database,
  identities,
  organizations,
  graph,
  policies,
  tokenKey: { keyId: "web-actual-product-key", key: randomBytes(32) },
  executors: executors as never,
  domain: { works },
  queries: { status: async () => ({ status: "ready", database: await database.version() }) },
  server: { host: "127.0.0.1", port: 17777 },
});
await product.start();
process.stdout.write(`Massion actual Web E2E server ready (${databaseName})\n`);

async function shutdown() {
  await product.close().catch(() => undefined);
  await database.close().catch(() => undefined);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
await new Promise(() => undefined);
