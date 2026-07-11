import { gzipSync } from "node:zlib";

import { Header } from "tar";

export const validManifest = {
  schemaVersion: "massion.extension.v1",
  name: "@massion-ext/echo",
  version: "1.0.0",
  displayName: "Echo",
  description: "테스트 echo extension",
  license: "Apache-2.0",
  compatibility: { agentOS: ">=1.0.0 <2.0.0", node: ">=24.0.0", surrealDB: ">=3.2.0 <4.0.0" },
  runtime: {
    entrypoint: "dist/worker.js",
    protocol: "massion.extension.rpc.v1",
    healthTimeoutMs: 5_000,
    stopTimeoutMs: 5_000,
  },
  permissions: {
    tools: [],
    network: [],
    files: [],
    secrets: [],
    process: [],
    mcp: [],
    storage: { quotaBytes: 1_048_576, maxValueBytes: 65_536 },
    events: [],
  },
  contributions: {
    runtimeTools: [{ id: "echo", handler: "echo" }],
    organizationTemplates: [],
    growthSignals: [],
    growthTargets: [],
    surfaceConnectors: [],
    eventConsumers: [],
    skills: [],
  },
  uninstall: { retention: "retain" },
} as const;

export const validPackage = {
  name: "@massion-ext/echo",
  version: "1.0.0",
  type: "module",
  files: ["dist", "massion.extension.json", "README.md", "LICENSE"],
  massion: { manifest: "massion.extension.json" },
  exports: "./dist/worker.js",
} as const;

export interface TestTarEntry {
  readonly path: string;
  readonly body?: string | Buffer;
  readonly type?: "File" | "Directory" | "SymbolicLink" | "Link";
  readonly linkpath?: string;
  readonly mode?: number;
  readonly declaredSize?: number;
}

export function makeTar(entries: readonly TestTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "", "utf8");
    const size = entry.declaredSize ?? (entry.type === "Directory" ? 0 : content.length);
    const block = Buffer.alloc(512);
    const header = new Header({
      path: entry.path,
      type: entry.type ?? "File",
      size,
      mode: entry.mode ?? (entry.type === "Directory" ? 0o755 : 0o644),
      uid: 0,
      gid: 0,
      mtime: new Date(0),
      ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }),
    });
    header.encode(block);
    blocks.push(block, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function validTar(extra: readonly TestTarEntry[] = []): Buffer {
  return makeTar([
    { path: "package/package.json", body: JSON.stringify(validPackage) },
    { path: "package/massion.extension.json", body: JSON.stringify(validManifest) },
    { path: "package/dist/worker.js", body: "export const worker = true;" },
    { path: "package/README.md", body: "# Echo" },
    { path: "package/LICENSE", body: "Apache-2.0" },
    ...extra,
  ]);
}
