import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "@massion/storage";

import { OidcPublisherAuthenticator, SurrealUploadGrantService, UploadGrantService } from "./auth.js";

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
    expect(
      grants.consume(issued.token, {
        packageName: "@massion-ext/github",
        packageVersion: "1.0.0",
        artifactDigest: "a".repeat(64),
      }),
    ).toMatchObject({ publisherId: "publisher-0001" });
    expect(() =>
      grants.consume(issued.token, {
        packageName: "@massion-ext/github",
        packageVersion: "1.0.0",
        artifactDigest: "a".repeat(64),
      }),
    ).toThrow("소비");
  });

  it("SurrealDB grant는 재시작·동시 replica에서도 한 번만 원자 소비한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: "upload-grant" });
    const options = { secret: Buffer.alloc(32, 9), now: () => new Date(1_000) };
    const issuer = await SurrealUploadGrantService.create(database, options);
    const issued = await issuer.issue({
      publisherId: "publisher-0001",
      packageName: "@massion-ext/github",
      packageVersion: "1.0.0",
      artifactDigest: "b".repeat(64),
      ttlSeconds: 300,
    });
    const replicaA = await SurrealUploadGrantService.create(database, options);
    const replicaB = await SurrealUploadGrantService.create(database, options);
    const expected = {
      packageName: "@massion-ext/github",
      packageVersion: "1.0.0",
      artifactDigest: "b".repeat(64),
    };
    const results = await Promise.allSettled([
      replicaA.consume(issued.token, expected),
      replicaB.consume(issued.token, expected),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
