import { describe, expect, it, vi } from "vitest";

import { OidcPublisherAuthenticator, UploadGrantService } from "./auth.js";

describe("Registry publish auth", () => {
  it("OIDC issuer·audience·subject·repository·workflow와 짧은 expiry를 검증한다", async () => {
    const verifyJwt = vi.fn(async () => ({
      payload: {
        iss: "https://token.actions.githubusercontent.com",
        aud: "registry.massion.dev",
        sub: "repo:massion-dev/extensions:ref:refs/tags/v1.0.0",
        repository: "massion-dev/extensions",
        job_workflow_ref: "massion-dev/extensions/.github/workflows/publish.yml@refs/tags/v1.0.0",
        iat: 1_000,
        exp: 1_300,
        jti: "oidc-jti-0001",
      },
    }));
    const auth = new OidcPublisherAuthenticator({ verifyJwt, now: () => new Date(1_100_000) });
    await expect(
      auth.authenticate("jwt", {
        issuer: "https://token.actions.githubusercontent.com",
        audience: "registry.massion.dev",
        subject: /^repo:massion-dev\/extensions:ref:refs\/tags\/v/u,
        repository: "massion-dev/extensions",
        workflow: /^massion-dev\/extensions\/\.github\/workflows\/publish\.yml@/u,
      }),
    ).resolves.toMatchObject({ repository: "massion-dev/extensions" });
  });

  it("upload grant를 package·version·digest에 결속하고 한 번만 소비한다", () => {
    const grants = new UploadGrantService({ secret: Buffer.alloc(32, 7), now: () => new Date(1_000) });
    const issued = grants.issue({
      publisherId: "publisher-0001",
      packageName: "@massion-ext/github",
      packageVersion: "1.0.0",
      artifactDigest: "a".repeat(64),
      ttlSeconds: 300,
    });
    expect(grants.consume(issued.token, {
      packageName: "@massion-ext/github",
      packageVersion: "1.0.0",
      artifactDigest: "a".repeat(64),
    })).toMatchObject({ publisherId: "publisher-0001" });
    expect(() => grants.consume(issued.token, {
      packageName: "@massion-ext/github",
      packageVersion: "1.0.0",
      artifactDigest: "a".repeat(64),
    })).toThrow("소비");
  });
});
