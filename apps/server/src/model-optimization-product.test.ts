import { ApplicationHttpClient } from "@massion/application";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseServerConfig } from "./config.js";
import { createMassionDaemon } from "./product.js";

describe("Massion server model optimization product boundary", () => {
  it("서버 bootstrap부터 실제 로컬 모델 평가·receipt·추천까지 연결한다", async () => {
    const modelServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "massion-evaluation-completion",
          object: "chat.completion",
          created: 1,
          model: "massion-evaluation-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "평가완료" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }),
      );
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("테스트 모델 주소를 찾을 수 없습니다");

    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-model-optimization-product-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 61).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 62).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const daemon = await createMassionDaemon({
      ...parsed,
      server: { ...parsed.server, port: 0 },
      metrics: { ...parsed.metrics, port: 0 },
      registry: { ...parsed.registry, port: 0 },
    });
    const address = await daemon.start();

    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "model-optimization-bootstrap-0001",
        email: "model-optimization-product@example.com",
        displayName: "Model Optimization Product",
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const command = async (operation: string, payload: unknown) =>
        (await client.command({
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          operation,
          payload,
        })) as { outcome: string; data: Record<string, unknown> };

      await command("router.provider.register", {
        providerId: "local-evaluation",
        displayName: "Local Evaluation",
        adapterKind: "openai-compatible",
      });
      const endpoint = await command("router.endpoint.register", {
        providerId: "local-evaluation",
        name: "Evaluation API",
        baseUrl: `http://127.0.0.1:${String(modelAddress.port)}/v1`,
        local: true,
      });
      await command("router.credential.add", {
        providerId: "local-evaluation",
        endpointId: endpoint.data.endpointId,
        label: "evaluation-account",
        credentialType: "api_key",
        secret: "evaluation-secret",
        priority: 1,
        weight: 1,
      });
      const model = await command("router.model.register", {
        providerId: "local-evaluation",
        endpointId: endpoint.data.endpointId,
        modelId: "massion-evaluation-model",
        routeKind: "chat",
        contextWindow: 32_000,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsStreaming: true,
        equivalenceGroup: "evaluation-model",
        evalScore: 1,
        inputCostMicrosPerMillion: 0,
        outputCostMicrosPerMillion: 0,
        verified: true,
      });
      const route = await command("router.route.configure", {
        name: "evaluation-quality",
        routeKind: "chat",
        credentialPolicy: "round-robin",
        dataPolicy: "external-allowed",
        equivalenceGroup: "evaluation-model",
        minEvalScore: 0,
        requireTools: false,
        requireStructuredOutput: false,
        requireVision: false,
        requireStreaming: false,
        maxContextTokens: 32_000,
        requestBudgetMicros: 1_000_000,
        totalBudgetMicros: 10_000_000,
      });
      await command("router.candidate.add", {
        routeId: route.data.routeId,
        modelProfileId: model.data.modelProfileId,
        priority: 1,
      });

      const bundle = await command("optimization.bundle.create", {
        roleKey: "assurance",
        runtimeVersion: "server-test-runtime",
        cases: [
          {
            prompt: "평가완료라고 답해주세요.",
            promptChecksum: "a".repeat(64),
            toolsChecksum: "b".repeat(64),
            environmentChecksum: "c".repeat(64),
            expectedOutcome: "평가완료",
          },
          {
            prompt: "평가완료라고 답해주세요.",
            promptChecksum: "d".repeat(64),
            toolsChecksum: "e".repeat(64),
            environmentChecksum: "f".repeat(64),
            expectedOutcome: "평가완료",
          },
          {
            prompt: "평가완료라고 답해주세요.",
            promptChecksum: "1".repeat(64),
            toolsChecksum: "2".repeat(64),
            environmentChecksum: "3".repeat(64),
            expectedOutcome: "평가완료",
          },
        ],
      });
      expect(bundle.outcome).toBe("succeeded");
      const receipt = await command("optimization.evaluation.execute", {
        roleKey: "assurance",
        bundleId: bundle.data.bundleId,
        modelProfileId: model.data.modelProfileId,
        runtimeVersion: "server-test-runtime",
      });
      expect(receipt).toMatchObject({
        outcome: "succeeded",
        data: {
          roleKey: "assurance",
          modelProfileId: model.data.modelProfileId,
          sampleCount: 3,
          qualityScore: 1,
          completed: true,
        },
      });

      const recommendation = await command("optimization.recommend", {
        roleKey: "assurance",
        candidates: [
          {
            modelProfileId: model.data.modelProfileId,
            modelId: model.data.modelId,
            routeId: route.data.routeId,
            providerId: "local-evaluation",
            verified: true,
            supportsStructuredOutput: true,
            supportsTools: true,
            supportsStreaming: true,
            dataPolicy: "external-allowed",
          },
        ],
        receipts: [receipt.data],
        requirements: {
          requiresTools: false,
          requiresStructuredOutput: false,
          requiresStreaming: false,
          dataPolicy: "external-allowed",
        },
      });
      expect(recommendation).toMatchObject({
        outcome: "succeeded",
        data: {
          roleKey: "assurance",
          primaryModelProfileId: model.data.modelProfileId,
          status: "pending-approval",
        },
      });
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve())));
    }
  }, 20_000);
});
