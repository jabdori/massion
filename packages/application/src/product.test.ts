import { randomBytes } from "node:crypto";

import { PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { ApplicationHttpClient } from "./http-client.js";
import { ApplicationProduct } from "./product.js";

describe("ApplicationProduct", () => {
  it("인증·명령·Core run·event를 하나의 실제 HTTP 제품 경계로 조립한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
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
              ? { outcome: "advanced" as const, workId: "product-work-0001" }
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
      tokenKey: { keyId: "product-test-key", key: randomBytes(32) },
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-bootstrap-command-0001",
      email: "product@example.com",
      displayName: "Product",
    })) as {
      access: { token: string };
      context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
    };
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    await expect(client.status()).resolves.toMatchObject({ data: { status: "ready" } });
    await expect(
      client.command({
        schemaVersion: "massion.application.v1",
        commandId: "product-run-command-0001",
        correlationId: "product-run-correlation-0001",
        operation: "run.start",
        payload: { request: { text: "제품 경계 검증" } },
      }),
    ).resolves.toMatchObject({ outcome: "accepted", data: { status: "ready" } });
    await product.drain();
    await expect(product.runs.getByCommand(initialized.context, "product-run-command-0001")).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
    await expect(client.events()).resolves.toMatchObject({ events: expect.any(Array) });
  });
});
