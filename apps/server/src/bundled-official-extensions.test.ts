import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { ExtensionPackageService } from "@massion/extension-host";
import { IdentityService, OrganizationService } from "@massion/identity";
import { FileArtifactStore, RegistryCatalog, SurrealRegistryStore } from "@massion/registry";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { seedBundledOfficialExtensions } from "./bundled-official-extensions.js";

describe("Bundled official Extension seed", () => {
  it("실제 공식 artifact를 공개 catalog에 시드하고 재실행해도 같은 version을 유지한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-bundled-extension-seed-"));
    await using database = await createDatabase({ url: "mem://", namespace: "registry", database: randomUUID() });
    try {
      const runtime = { agentOS: "1.0.0", node: process.versions.node, surrealDB: "3.2.0" };
      const packed = await new ExtensionPackageService({ runtime }).pack(resolve(process.cwd(), "../../extensions/slack"), root);
      const archive = packed.tarballPath.split("/").pop();
      if (!archive) throw new Error("공식 Extension archive 이름이 없습니다");
      await writeFile(
        join(root, "official-extensions.json"),
        JSON.stringify([
          {
            packageName: packed.artifact.manifest.name,
            packageVersion: packed.artifact.manifest.version,
            archive,
            artifactDigest: packed.artifact.artifactDigest,
          },
        ]),
      );
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const versions = await SurrealRegistryStore.create(database, organizations);
      const artifacts = new FileArtifactStore(join(root, "artifacts"));
      const input = { root, identities, organizations, versions, artifacts, runtime };

      await seedBundledOfficialExtensions(input);
      await seedBundledOfficialExtensions(input);

      const catalog = new RegistryCatalog(versions.catalogStore(), { tokenSecret: Buffer.alloc(32, 5) });
      const discovered = await catalog.search({ organizationId: "fresh-organization", query: "slack", runtime, limit: 10 });
      expect(discovered.items).toHaveLength(1);
      expect(discovered.items[0]).toMatchObject({
        packageName: "@massion-ext/slack",
        packageVersion: "1.0.0",
        visibility: "public",
      });
      expect(await artifacts.get(packed.artifact.artifactDigest)).toEqual(await readFile(packed.tarballPath));
      expect(await versions.catalogStore().list()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
