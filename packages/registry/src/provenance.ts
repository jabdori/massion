import { createHash } from "node:crypto";

import { verify as verifySigstore } from "sigstore";

export interface ProvenancePolicy {
  readonly issuer: string;
  readonly identity: RegExp;
}

export interface ProvenanceResult {
  readonly outcome: "pass";
  readonly issuer: string;
  readonly identity: string;
  readonly sourceRepository?: string;
  readonly predicateType: string;
}

interface SignerResult {
  readonly identity?: {
    readonly subjectAlternativeName?: string;
    readonly extensions?: { readonly issuer?: string };
  };
}

type CryptographicVerify = (bundle: Parameters<typeof verifySigstore>[0]) => Promise<SignerResult>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이 유효하지 않습니다`);
  return value as Record<string, unknown>;
}

export class SigstoreProvenanceVerifier {
  private readonly cryptographicVerify: CryptographicVerify;

  public constructor(options: { readonly cryptographicVerify?: CryptographicVerify } = {}) {
    this.cryptographicVerify =
      options.cryptographicVerify ?? (async (bundle) => await verifySigstore(bundle, { timeout: 5_000 }));
  }

  public async verify(artifact: Buffer, bundleValue: unknown, policy: ProvenancePolicy): Promise<ProvenanceResult> {
    const encoded = JSON.stringify(bundleValue);
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error("Sigstore bundle byte 상한을 초과했습니다");
    const bundle = record(bundleValue, "Sigstore bundle");
    const envelope = record(bundle.dsseEnvelope, "Sigstore DSSE envelope");
    if (typeof envelope.payload !== "string" || envelope.payload.length > 512 * 1024)
      throw new Error("Sigstore payload가 유효하지 않습니다");
    const payload = Buffer.from(envelope.payload, "base64");
    if (payload.length === 0 || payload.length > 256 * 1024)
      throw new Error("provenance payload byte 상한을 초과했습니다");
    let statementValue: unknown;
    try {
      statementValue = JSON.parse(payload.toString("utf8")) as unknown;
    } catch {
      throw new Error("provenance statement JSON이 유효하지 않습니다");
    }
    const statement = record(statementValue, "in-toto statement");
    if (statement._type !== "https://in-toto.io/Statement/v1")
      throw new Error("in-toto statement type이 유효하지 않습니다");
    if (
      typeof statement.predicateType !== "string" ||
      !statement.predicateType.startsWith("https://slsa.dev/provenance/")
    )
      throw new Error("SLSA provenance predicate가 필요합니다");
    const subjects = Array.isArray(statement.subject) ? statement.subject : [];
    const artifactDigest = createHash("sha256").update(artifact).digest("hex");
    const matches = subjects.some((candidate) => {
      const subject = record(candidate, "provenance subject");
      const digest = record(subject.digest, "provenance subject digest");
      return digest.sha256 === artifactDigest;
    });
    if (!matches) throw new Error("provenance subject digest가 artifact와 일치하지 않습니다");
    const signer = await this.cryptographicVerify(bundleValue as Parameters<typeof verifySigstore>[0]);
    const issuer = signer.identity?.extensions?.issuer;
    const identity = signer.identity?.subjectAlternativeName;
    if (issuer !== policy.issuer) throw new Error("provenance certificate issuer가 trust policy와 다릅니다");
    if (!identity || !policy.identity.test(identity))
      throw new Error("provenance certificate identity가 trust policy와 다릅니다");
    const predicate = record(statement.predicate, "provenance predicate");
    const definition = predicate.buildDefinition;
    const parameters =
      definition && typeof definition === "object"
        ? (definition as Record<string, unknown>).externalParameters
        : undefined;
    const sourceRepository =
      parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>).source : undefined;
    return {
      outcome: "pass",
      issuer,
      identity,
      ...(typeof sourceRepository === "string" ? { sourceRepository } : {}),
      predicateType: statement.predicateType,
    };
  }
}
