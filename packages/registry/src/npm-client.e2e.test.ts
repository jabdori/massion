import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { ExtensionPackageService } from "@massion/extension-host";
import { afterEach, describe, expect, it } from "vitest";

import { RegistryCatalog } from "./catalog.js";
import { RegistryHttpHandler } from "./http.js";
import { MemoryArtifactStore } from "./service.js";
import { MemoryRegistryStore } from "./store.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))),
);

describe("actual npm client contract", () => {
  it("npm pack이 Massion packument와 signed tarball을 사용한다", async () => {
    const sourcePack = await mkdtemp(join(tmpdir(), "massion-npm-source-"));
    roots.push(sourcePack);
    const packed = await new ExtensionPackageService({
      runtime: { agentOS: "1.0.0", node: process.versions.node, surrealDB: "3.2.0" },
    }).pack(resolve(process.cwd(), "../../extensions/slack"), sourcePack);
    const body = await readFile(packed.tarballPath);
    const digest = createHash("sha256").update(body).digest("hex");
    const store = new MemoryRegistryStore();
    const artifacts = new MemoryArtifactStore();
    await artifacts.put(digest, body);
    const staged = await store.stage("npm-e2e-stage-1", {
      packageName: "@massion-ext/slack",
      packageVersion: "1.0.0",
      artifactDigest: digest,
      contentDigest: "b".repeat(64),
      visibility: "public",
      ownerOrganizationId: "org-owner",
      manifest: { description: "Slack", compatibility: { agentOS: "^1.0.0", node: ">=24" } },
    });
    await store.recordAssessment(staged.versionId, {
      archive: "pass",
      provenance: "pass",
      sbom: "pass",
      vulnerability: "pass",
      contract: "pass",
      policy: "pass",
    });
    await store.publish(staged.versionId, "npm-e2e-decision-1");
    let handler: RegistryHttpHandler;
    const server = createServer((incoming, outgoing) => {
      void (async () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("server address가 없습니다");
        const request = new Request(`http://127.0.0.1:${String(address.port)}${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
        });
        const response = await handler.handle(request, "npm-community");
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })().catch((error: unknown) => {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : "failure" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address가 없습니다");
      const baseUrl = `http://127.0.0.1:${String(address.port)}`;
      handler = new RegistryHttpHandler({
        catalog: new RegistryCatalog(store, { tokenSecret: Buffer.alloc(32, 9) }),
        artifacts,
        publicBaseUrl: baseUrl,
      });
      const destination = await mkdtemp(join(tmpdir(), "massion-npm-client-"));
      roots.push(destination);
      const { stdout } = await execute(
        "npm",
        [
          "pack",
          "@massion-ext/slack@1.0.0",
          "--registry",
          `${baseUrl}/npm/`,
          "--ignore-scripts",
          "--pack-destination",
          destination,
          "--json",
        ],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      const result = JSON.parse(stdout) as { filename: string }[];
      expect(await readFile(join(destination, result[0]?.filename ?? "missing"))).toEqual(body);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 30_000);
});
