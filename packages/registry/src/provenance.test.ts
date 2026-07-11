import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { SigstoreProvenanceVerifier } from "./provenance.js";

function bundle(statement: unknown): Record<string, unknown> {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ sig: "AA==", keyid: "" }],
    },
    verificationMaterial: { tlogEntries: [{}] },
  };
}

describe("Sigstore provenance", () => {
  it("crypto 검증, identity와 in-toto subject artifact digest를 모두 결속한다", async () => {
    const artifact = Buffer.from("artifact");
    const digest = createHash("sha256").update(artifact).digest("hex");
    const cryptographicVerify = vi.fn(async () => ({
      identity: {
        subjectAlternativeName: "https://github.com/massion-dev/extensions/.github/workflows/publish.yml@refs/tags/v1.0.0",
        extensions: { issuer: "https://token.actions.githubusercontent.com" },
      },
    }));
    const verifier = new SigstoreProvenanceVerifier({ cryptographicVerify });
    const result = await verifier.verify(
      artifact,
      bundle({
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: "package.tgz", digest: { sha256: digest } }],
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: { buildDefinition: { externalParameters: { source: "github.com/massion-dev/extensions" } } },
      }),
      {
        issuer: "https://token.actions.githubusercontent.com",
        identity: /^https:\/\/github\.com\/massion-dev\/extensions\//u,
      },
    );
    expect(result.outcome).toBe("pass");
    expect(cryptographicVerify).toHaveBeenCalledOnce();
    await expect(
      verifier.verify(
        Buffer.from("changed"),
        bundle({
          _type: "https://in-toto.io/Statement/v1",
          subject: [{ name: "package.tgz", digest: { sha256: digest } }],
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {},
        }),
        {
          issuer: "https://token.actions.githubusercontent.com",
          identity: /^https:\/\/github\.com\/massion-dev\/extensions\//u,
        },
      ),
    ).rejects.toThrow("subject digest");
  });
});
