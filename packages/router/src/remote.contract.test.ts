import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { ModelRouter } from "./model-router.js";
import { ProviderService } from "./provider.js";
import { CredentialVault } from "./vault.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("remote Model Router contract", () => {
  remoteTest("원격 SurrealDB에서 암호화 credential·reservation·정산을 원자 적용한다", async () => {
    const databaseName = `router_${crypto.randomUUID().replaceAll("-", "")}`;
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
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)));
    const router = await ModelRouter.create(database, organizations, providers);
    await providers.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      displayName: "OpenAI Compatible",
      adapterKind: "openai-compatible",
    });
    const endpoint = await providers.registerEndpoint(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      name: "Remote",
      baseUrl: "https://models.example/v1",
      local: false,
    });
    await providers.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      endpointId: endpoint.endpoint.endpoint_id,
      label: "remote-key",
      credentialType: "api_key",
      secret: "remote-secret",
      priority: 1,
      weight: 1,
    });
    const profile = await router.registerModel(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      endpointId: endpoint.endpoint.endpoint_id,
      modelId: "remote-model",
      routeKind: "chat",
      contextWindow: 32_000,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "remote",
      evalScore: 0.9,
      inputCostMicrosPerMillion: 1_000_000,
      outputCostMicrosPerMillion: 1_000_000,
      verified: true,
    });
    const route = await router.createRoute(context, {
      commandId: crypto.randomUUID(),
      name: "remote-chat",
      routeKind: "chat",
      credentialPolicy: "priority",
      dataPolicy: "external-allowed",
      equivalenceGroup: "remote",
      minEvalScore: 0.8,
      requireTools: true,
      requireStructuredOutput: true,
      requireVision: false,
      requireStreaming: true,
      maxContextTokens: 16_000,
      requestBudgetMicros: 1_000,
      totalBudgetMicros: 10_000,
    });
    await router.addCandidate(context, {
      commandId: crypto.randomUUID(),
      routeId: route.route.route_id,
      modelProfileId: profile.profile.model_profile_id,
      priority: 1,
    });
    const reservation = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: route.route.name,
      estimatedTokens: 100,
      estimatedCostMicros: 500,
    });
    const succeeded = await router.reportSuccess(context, {
      commandId: crypto.randomUUID(),
      attemptId: reservation.attempt.attempt_id,
      actualInputTokens: 20,
      actualOutputTokens: 10,
      actualCostMicros: 300,
    });
    const raw = JSON.stringify(await database.query("SELECT * FROM credential_secret_version;"));

    expect(await database.version()).toMatch(/^surrealdb-3\./u);
    expect(reservation.secret).toBe("remote-secret");
    expect(succeeded.attempt.status).toBe("succeeded");
    expect(raw).not.toContain("remote-secret");
  });
});
