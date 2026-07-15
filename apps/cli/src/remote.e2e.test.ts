import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { ApplicationProduct } from "@massion/application";
import { PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("massion remote product E2E", () => {
  remoteTest(
    "실제 SurrealDB 제품에서 init→status→run→JSON Lines를 child process로 실행한다",
    async () => {
      const databaseName = `cli_${randomUUID().replaceAll("-", "")}`;
      const sqlUrl = (remoteUrl ?? "")
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
      if (!provisioned.ok) throw new Error(`CLI 원격 DB 프로비저닝 실패: ${String(provisioned.status)}`);
      await using database = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "massion",
        database: databaseName,
        authentication: { username: "root", password: "root" },
      });
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const graph = await OrganizationGraphService.create(database, organizations);
      const policies = await PolicyStore.create(database, organizations);
      const stages = ["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const;
      const executors = Object.fromEntries(
        stages.map((stage) => [
          stage,
          {
            execute: async () =>
              stage === "intake"
                ? { outcome: "advanced" as const, workId: `cli-work-${randomUUID()}` }
                : { outcome: "advanced" as const },
          },
        ]),
      ) as never;
      await using product = await ApplicationProduct.create({
        database,
        identities,
        organizations,
        graph,
        policies,
        tokenKey: { keyId: "cli-remote-key", key: randomBytes(32) },
        executors,
        domain: {},
        queries: { status: async () => ({ status: "ready", database: await database.version() }) },
      });
      const endpoint = await product.start();
      const home = await mkdtemp(join(tmpdir(), "massion-cli-remote-"));
      const run = async (args: readonly string[], input?: string) => {
        const child = spawn(process.execPath, [resolve("dist/main.js"), ...args], {
          cwd: resolve("."),
          env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (value) => {
          stdout += value;
        });
        child.stderr.on("data", (value) => {
          stderr += value;
        });
        child.stdin.end(input);
        const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
        return { code, stdout, stderr };
      };
      try {
        const initialized = await run([
          "init",
          endpoint.url,
          `cli-${randomUUID()}@example.com`,
          "CLI Remote",
          "--json",
        ]);
        expect(initialized).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(initialized.stdout)).toMatchObject({ profile: "local" });
        const status = await run(["status", "--json"]);
        expect(status).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(status.stdout)).toMatchObject({ data: { status: "ready", database: "surrealdb-3.2.0" } });
        const detached = await run(["run", "원격 제품 실행", "--detach", "--json"]);
        expect(detached).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(detached.stdout)).toMatchObject({ type: "accepted", runId: expect.any(String) });
        const envelope = {
          schemaVersion: "massion.application.v1",
          commandId: "cli-jsonl-run-command-0001",
          correlationId: "cli-jsonl-run-correlation-0001",
          operation: "run.start",
          payload: { request: { text: "JSON Lines 실행" } },
        };
        const jsonl = await run(["run", "--jsonl"], `${JSON.stringify(envelope)}\n`);
        expect(jsonl).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(jsonl.stdout)).toMatchObject({ schemaVersion: "massion.cli.jsonl.v1", type: "result" });
        await product.drain();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
