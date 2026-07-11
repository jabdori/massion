import { randomBytes, randomUUID } from "node:crypto";

import { ApplicationHttpClient, ApplicationProduct } from "@massion/application";
import { ExtensionStore } from "@massion/extension-host";
import { ApprovalStore, GovernanceService, PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it } from "vitest";

import { TuiController } from "./controller.js";
import { createTuiState, reduceTuiState } from "./state.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("TUI remote product contract", () => {
  remoteTest(
    "실제 SurrealDB 제품의 token→HTTP→Identity→협업 snapshot을 TUI 상태로 연결한다",
    async () => {
      const databaseName = `tui_${randomUUID().replaceAll("-", "")}`;
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
      if (!provisioned.ok) throw new Error(`TUI 원격 DB 프로비저닝 실패: ${String(provisioned.status)}`);
      await using database = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "massion",
        database: databaseName,
        authentication: { username: "root", password: "root" },
      });
      expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const graph = await OrganizationGraphService.create(database, organizations);
      const policies = await PolicyStore.create(database, organizations);
      const works = await WorkService.create(database, organizations, graph);
      await RuntimeExecutionStore.create(database, organizations);
      const governance = await GovernanceService.create(database, organizations, policies);
      await ApprovalStore.create(database, organizations, governance);
      await ExtensionStore.create(database, organizations);
      const stages = ["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const;
      const executors = Object.fromEntries(
        stages.map((stage) => [
          stage,
          {
            execute: async () =>
              stage === "intake"
                ? { outcome: "advanced" as const, workId: `tui-work-${randomUUID()}` }
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
        tokenKey: { keyId: "tui-remote-key", key: randomBytes(32) },
        executors,
        domain: { works },
        queries: { status: async () => ({ status: "ready", database: await database.version() }) },
      });
      const endpoint = await product.start();
      const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
        commandId: `tui-bootstrap-${randomUUID()}`,
        email: `tui-${randomUUID()}@example.com`,
        displayName: "TUI Remote",
      })) as {
        access: { token: string };
        context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
        coreOffice: { version: { version_id: string } };
      };
      await product.queries.query(initialized.context, ["application:*"], "organization.graph.snapshot", {});
      const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
      await client.command({
        schemaVersion: "massion.application.v1",
        commandId: `tui-work-${randomUUID()}`,
        correlationId: `tui-correlation-${randomUUID()}`,
        operation: "work.create",
        payload: {
          text: "TUI 원격 협업 상태 검증",
          surface: "tui-contract",
          organizationVersionId: initialized.coreOffice.version.version_id,
        },
      });
      let state = createTuiState();
      const controller = new TuiController(
        client,
        (action) => {
          state = reduceTuiState(state, action);
        },
        () => state,
      );
      await controller.refresh();
      expect(state.connection).toBe("live");
      expect(state.snapshot).toMatchObject({
        schemaVersion: "massion.collaboration.snapshot.v1",
        organization: { organizationId: controller.identity.organizationId },
        nodes: expect.arrayContaining([expect.objectContaining({ handle: "representative" })]),
        works: expect.arrayContaining([expect.objectContaining({ status: "draft" })]),
      });
      const signals = new AbortController();
      const streamed = await Promise.race([
        (async () => {
          const events: unknown[] = [];
          for await (const value of client.streamEvents(0, signals.signal)) {
            events.push(value);
            if ((value as { type?: unknown }).type === "work.created") {
              signals.abort();
              return events;
            }
          }
          throw new Error("TUI 원격 SSE가 사건 없이 종료됐습니다");
        })(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("TUI 원격 SSE 시간 초과")), 5_000)),
      ]);
      expect(streamed).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "work.created", sequence: expect.any(Number) })]),
      );
      const sequences = streamed.map((value) => (value as { sequence: number }).sequence);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    },
    30_000,
  );
});
