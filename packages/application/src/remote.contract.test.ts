import { randomBytes, randomUUID } from "node:crypto";

import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it } from "vitest";

import { registerApplicationDomainCommands } from "./adapters/domain.js";
import { SurrealApplicationReadModel } from "./adapters/read-model.js";
import { ApplicationAccessTokenService } from "./auth.js";
import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";
import { APPLICATION_RUN_STAGES, CoreWorkCoordinator, type CoreWorkStageExecutor } from "./core-work-coordinator.js";
import { ApplicationEventProjector } from "./event-projector.js";
import { ApplicationEventStore } from "./event-store.js";
import { ApplicationHttpClient } from "./http-client.js";
import { ApplicationHttpServer } from "./http-server.js";
import { ApplicationQueryRegistry, registerApplicationQueries } from "./query-registry.js";
import { ApplicationRunStore } from "./run-store.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("Application remote product contract", () => {
  remoteTest(
    "실제 SurrealDB 3.2.x에서 token→HTTP→command replay→outbox→run recovery를 연결한다",
    async () => {
      const databaseName = `application_${randomUUID().replaceAll("-", "")}`;
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
      if (!provisioned.ok) throw new Error(`SurrealDB 원격 테스트 프로비저닝 실패: ${String(provisioned.status)}`);
      await using database = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "massion",
        database: databaseName,
        authentication: { username: "root", password: "root" },
      });
      expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identities.registerPersonalUser({
        email: `remote-${randomUUID()}@example.com`,
        displayName: "Remote",
      });
      const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const graph = await OrganizationGraphService.create(database, organizations);
      const core = await graph.bootstrap(context);
      const works = await WorkService.create(database, organizations, graph);
      const readModel = new SurrealApplicationReadModel(database, organizations);
      const queries = new ApplicationQueryRegistry();
      registerApplicationQueries(queries, { readModel, status: async () => ({ database: await database.version() }) });
      const commandStore = await ApplicationCommandStore.create(database, organizations);
      const commands = new ApplicationCommandRegistry(commandStore);
      registerApplicationDomainCommands(commands, { works });
      const tokens = await ApplicationAccessTokenService.create(database, organizations, {
        keyId: "remote-http-key",
        key: randomBytes(32),
      });
      const events = await ApplicationEventStore.create(database, organizations);
      const projector = await ApplicationEventProjector.create(database, organizations);
      const issued = await tokens.issue(context, {
        commandId: "remote-token-command-0001",
        audience: "massion-api",
        scopes: ["application:*"],
        ttlSeconds: 3600,
      });
      if (!issued.token) throw new Error("remote token 원문이 없습니다");
      const server = new ApplicationHttpServer({ auth: tokens, queries, commands, events });
      const address = await server.start();
      try {
        const client = new ApplicationHttpClient({ baseUrl: address.url, token: issued.token });
        await expect(client.status()).resolves.toMatchObject({
          data: { database: expect.stringMatching(/^surrealdb-3\.2\./u) },
        });
        const command = {
          schemaVersion: "massion.application.v1",
          commandId: "remote-work-command-0001",
          correlationId: "remote-work-correlation-0001",
          operation: "work.create",
          payload: {
            text: "실제 원격 제품 계약",
            surface: "remote-test",
            organizationVersionId: core.version.version_id,
          },
        };
        const first = await client.command(command);
        const replay = await client.command(command);
        expect(replay).toEqual(first);
        await projector.projectPending(context, 100);
        await expect(client.query("work.list", {})).resolves.toMatchObject({ data: [{ status: "draft" }] });
        await expect(client.events(0)).resolves.toMatchObject({
          events: expect.arrayContaining([expect.objectContaining({ type: "work.created" })]),
        });
      } finally {
        await server.close();
      }

      const runStore = await ApplicationRunStore.create(database, organizations, { leaseMs: 1000 });
      const stage: CoreWorkStageExecutor = {
        execute: async (_context, input) => ({
          outcome: "advanced",
          ...(input.workId ? {} : { workId: "remote-run-work" }),
        }),
      };
      const coordinator = new CoreWorkCoordinator(
        runStore,
        Object.fromEntries(APPLICATION_RUN_STAGES.map((name) => [name, stage])) as never,
      );
      await expect(
        coordinator.start(context, {
          commandId: "remote-run-command-0001",
          correlationId: "remote-run-correlation-0001",
          request: {},
        }),
      ).resolves.toMatchObject({ status: "completed", stage: "terminal" });
    },
    30_000,
  );
});
