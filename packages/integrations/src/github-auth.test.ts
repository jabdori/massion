import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createGitHubAppJwt, GITHUB_API_VERSION, GitHubInstallationTokenManager } from "./github-auth.js";

describe("GitHub App 인증", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const now = new Date("2026-07-11T00:00:00.000Z");

  it("RS256 JWT를 10분 미만 수명과 60초 clock skew로 서명한다", () => {
    const jwt = createGitHubAppJwt({ clientId: "Iv1_client123", privateKeyPem, now });
    const [header, payload, signature] = jwt.split(".");
    if (!header || !payload || !signature) throw new Error("JWT segment가 없습니다");
    expect(JSON.parse(Buffer.from(header, "base64url").toString()) as unknown).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()) as unknown).toEqual({
      iat: Math.floor(now.getTime() / 1000) - 60,
      exp: Math.floor(now.getTime() / 1000) + 540,
      iss: "Iv1_client123",
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("installation token의 형식 길이를 가정하지 않고 만료 5분 전까지 cache한다", async () => {
    const exchange = vi.fn(async () => ({
      token: "ghs_APPID_JWT_stateless_token_more_than_40_characters",
      expires_at: "2026-07-11T01:00:00.000Z",
    }));
    const manager = new GitHubInstallationTokenManager({
      clientId: "Iv1_client123",
      privateKey: async () => privateKeyPem,
      exchange,
    });
    const options = { now, repositoryIds: [123], permissions: { checks: "write" as const } };
    const first = await manager.get("98765432", options);
    const cached = await manager.get("98765432", { ...options, now: new Date("2026-07-11T00:54:59.000Z") });
    expect(cached).toBe(first);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "98765432",
        authorization: expect.stringMatching(/^Bearer /u),
        apiVersion: GITHUB_API_VERSION,
        repositoryIds: [123],
        permissions: { checks: "write" },
      }),
    );
    await manager.get("98765432", { ...options, now: new Date("2026-07-11T00:55:00.000Z") });
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it("만료됐거나 비정상인 token 응답을 cache하지 않는다", async () => {
    const manager = new GitHubInstallationTokenManager({
      clientId: "Iv1_client123",
      privateKey: async () => privateKeyPem,
      exchange: async () => ({ token: "short", expires_at: "2026-07-10T00:00:00.000Z" }),
    });
    await expect(manager.get("98765432", { now })).rejects.toThrow("token");
  });
});
