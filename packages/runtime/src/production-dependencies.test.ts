import { describe, expect, it } from "vitest";

describe("Runtime production peer dependencies", () => {
  it("VoltAgent provider·GraphQL·WebSocket peer를 직접 조립한다", async () => {
    await expect(import("@ai-sdk/provider")).resolves.toBeTypeOf("object");
    await expect(import("graphql")).resolves.toBeTypeOf("object");
    await expect(import("ws")).resolves.toBeTypeOf("object");
  });
});
