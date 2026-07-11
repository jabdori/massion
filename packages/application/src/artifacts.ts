import type { ExtensionGateway, ExtensionRuntimeVersions } from "@massion/extension-host";
import { inspectExtensionArchive } from "@massion/extension-host";
import type { TenantContext } from "@massion/identity";

interface InspectedArtifact {
  readonly artifactDigest: string;
  readonly contentDigest: string;
  readonly manifest: {
    readonly name: string;
    readonly version: string;
    readonly runtime: { readonly entrypoint: string };
  };
  readonly files: readonly { readonly path: string; readonly size: number; readonly digest: string }[];
}

type Inspector = (archive: Buffer) => Promise<InspectedArtifact>;

export class ApplicationArtifactGateway {
  private readonly inspector: Inspector;

  public constructor(
    private readonly extensions: Pick<ExtensionGateway, "install" | "update">,
    inspector?: Inspector,
    runtime: ExtensionRuntimeVersions = { agentOS: "1.0.0", node: process.versions.node, surrealDB: "3.2.0" },
  ) {
    this.inspector =
      inspector ??
      (async (archive) =>
        await inspectExtensionArchive(archive, { runtime, limits: { maxArchiveBytes: 64 * 1024 * 1024 } }));
  }

  public async inspect(_context: TenantContext, archive: Buffer): Promise<unknown> {
    const report = await this.inspector(archive);
    return {
      artifactDigest: report.artifactDigest,
      contentDigest: report.contentDigest,
      packageName: report.manifest.name,
      packageVersion: report.manifest.version,
      runtimeEntrypoint: report.manifest.runtime.entrypoint,
      fileCount: report.files.length,
      files: report.files.map((file) => ({ path: file.path, size: file.size, digest: file.digest })),
    };
  }

  public async install(
    context: TenantContext,
    input: { readonly commandId: string; readonly archive: Buffer },
  ): Promise<unknown> {
    return await this.extensions.install(context, input);
  }

  public async update(
    context: TenantContext,
    input: { readonly commandId: string; readonly archive: Buffer },
  ): Promise<unknown> {
    return await this.extensions.update(context, input);
  }
}
