import type { ExtensionManifestV1 } from "@massion/extension-sdk";

export interface ExtensionRuntimeVersions {
  readonly agentOS: string;
  readonly node: string;
  readonly surrealDB?: string;
}

export interface ExtensionArtifactFile {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly digest: string;
}

export interface ExtensionArtifactReport {
  readonly packageJson: Readonly<Record<string, unknown>>;
  readonly manifest: ExtensionManifestV1;
  readonly artifactDigest: string;
  readonly contentDigest: string;
  readonly files: readonly ExtensionArtifactFile[];
}
