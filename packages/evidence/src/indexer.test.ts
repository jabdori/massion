import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EvidenceIndexer,
  EvidenceParser,
  IndexStore,
  RepositoryScanner,
  RepositoryStore,
  type EvidenceParserPort,
} from "./index.js";

const SCAN_OPTIONS = { include: ["**/*"], exclude: [], maxFileBytes: 128 * 1_024 } as const;

describe("원자적 Repository index 작성", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let root: string;
  let scanner: RepositoryScanner;
  let repositories: RepositoryStore;
  let indexes: IndexStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "indexer@example.com", displayName: "Indexer" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    root = await mkdtemp(path.join(os.tmpdir(), "massion-indexer-"));
    scanner = new RepositoryScanner();
    repositories = await RepositoryStore.create(database, organizations);
    indexes = await IndexStore.create(database, organizations);
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  async function prepareRevision(repositoryId?: string) {
    const scan = await scanner.scan(root, SCAN_OPTIONS);
    const repository = repositoryId
      ? await repositories.getRepository(context, repositoryId)
      : (
          await repositories.register(context, {
            commandId: crypto.randomUUID(),
            name: "fixture",
            providerKind: "filesystem",
            rootRef: root,
            rootRealPathHash: scan.rootRealPathHash,
          })
        ).repository;
    const revision = (
      await repositories.captureRevision(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        providerRevision: `snapshot:${scan.manifestChecksum}`,
        dirty: false,
        manifestChecksum: scan.manifestChecksum,
        rootRealPathHash: scan.rootRealPathHash,
        collectorVersion: "test-v1",
      })
    ).revision;
    return { repository, revision, scan };
  }

  async function prepareConfiguration(
    repositoryId: string,
    embeddingStatus: "unavailable" | "pending" = "unavailable",
  ) {
    return (
      await repositories.createConfiguration(context, {
        commandId: crypto.randomUUID(),
        repositoryId,
        checksum: createHash("sha256")
          .update(JSON.stringify({ ...SCAN_OPTIONS, embeddingStatus }))
          .digest("hex"),
        parserBundleVersion: "vscode-tree-sitter-wasm-0.3.1",
        schemaVersion: "evidence-v1",
        embeddingStatus,
        settings: SCAN_OPTIONS,
      })
    ).configuration;
  }

  it("full index를 staging에 쓰고 완성된 snapshot만 current로 전환한다", async () => {
    await writeFile(
      path.join(root, "service.ts"),
      "export class Service { run() { return helper(); } }\nfunction helper() { return 1; }\n",
    );
    await writeFile(path.join(root, "README.md"), "# Service\n\nReliable evidence.\n");
    const { repository, revision } = await prepareRevision();
    const configuration = await prepareConfiguration(repository.repositoryId);
    const indexer = new EvidenceIndexer(repositories, indexes, scanner, new EvidenceParser());

    const result = await indexer.index(context, {
      commandId: crypto.randomUUID(),
      repositoryId: repository.repositoryId,
      repositoryRevisionId: revision.repositoryRevisionId,
      configurationId: configuration.configurationId,
      mode: "full",
      root,
      scanOptions: SCAN_OPTIONS,
    });
    const snapshot = await indexes.getSnapshot(context, result.index.indexVersionId);

    expect(result.index).toMatchObject({ status: "complete", current: true, embeddingStatus: "unavailable" });
    expect(snapshot.files.map((file) => file.relativePath)).toEqual(["README.md", "service.ts"]);
    expect(snapshot.symbols.map((symbol) => symbol.qualifiedName)).toEqual(
      expect.arrayContaining(["Service", "Service.run", "helper"]),
    );
    expect(snapshot.relations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "calls", resolved: true })]),
    );
    expect(result.index.snapshotChecksum).toBe(snapshot.checksum);
    expect(await repositories.audit(context, repository.repositoryId)).toEqual([]);
  });

  it("parser 실패와 실행 crash는 이전 current를 보존하고 각각 partial과 failed version을 남긴다", async () => {
    await writeFile(path.join(root, "stable.ts"), "export const stable = 1;\n");
    const firstRevision = await prepareRevision();
    const configuration = await prepareConfiguration(firstRevision.repository.repositoryId);
    const normal = new EvidenceIndexer(repositories, indexes, scanner, new EvidenceParser());
    const first = await normal.index(context, {
      commandId: crypto.randomUUID(),
      repositoryId: firstRevision.repository.repositoryId,
      repositoryRevisionId: firstRevision.revision.repositoryRevisionId,
      configurationId: configuration.configurationId,
      mode: "full",
      root,
      scanOptions: SCAN_OPTIONS,
    });

    await writeFile(path.join(root, "broken.ts"), "export const broken = true;\n");
    const secondRevision = await prepareRevision(firstRevision.repository.repositoryId);
    const failingParser: EvidenceParserPort = {
      parse: async (input) => {
        if (input.relativePath === "broken.ts") throw new Error("parser unavailable");
        return await new EvidenceParser().parse(input);
      },
    };
    const partial = new EvidenceIndexer(repositories, indexes, scanner, failingParser);
    await expect(
      partial.index(context, {
        commandId: crypto.randomUUID(),
        repositoryId: firstRevision.repository.repositoryId,
        repositoryRevisionId: secondRevision.revision.repositoryRevisionId,
        configurationId: configuration.configurationId,
        mode: "incremental",
        parentIndexVersionId: first.index.indexVersionId,
        root,
        scanOptions: SCAN_OPTIONS,
      }),
    ).rejects.toThrow("parser unavailable");

    const crashing = new EvidenceIndexer(repositories, indexes, scanner, new EvidenceParser(), {
      afterStagedFile: () => {
        throw new Error("injected crash");
      },
    });
    await expect(
      crashing.index(context, {
        commandId: crypto.randomUUID(),
        repositoryId: firstRevision.repository.repositoryId,
        repositoryRevisionId: secondRevision.revision.repositoryRevisionId,
        configurationId: configuration.configurationId,
        mode: "reconcile",
        parentIndexVersionId: first.index.indexVersionId,
        root,
        scanOptions: SCAN_OPTIONS,
      }),
    ).rejects.toThrow("injected crash");

    const versions = await repositories.listIndexes(context, firstRevision.repository.repositoryId);
    expect(versions.map(({ status, current }) => [status, current])).toEqual([
      ["complete", true],
      ["partial", false],
      ["failed", false],
    ]);
    expect((await repositories.getCurrentIndex(context, firstRevision.repository.repositoryId))?.indexVersionId).toBe(
      first.index.indexVersionId,
    );
  });

  it("incremental index가 unchanged 결과를 복제하고 create·modify·delete·rename을 완전 snapshot으로 반영한다", async () => {
    await writeFile(path.join(root, "unchanged.ts"), "export function unchanged() { return 1; }\n");
    await writeFile(path.join(root, "modify.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "delete.ts"), "export const removed = true;\n");
    await writeFile(path.join(root, "rename.ts"), "export class Renamed {}\n");
    const initial = await prepareRevision();
    const configuration = await prepareConfiguration(initial.repository.repositoryId);
    const indexer = new EvidenceIndexer(repositories, indexes, scanner, new EvidenceParser());
    const first = await indexer.index(context, {
      commandId: crypto.randomUUID(),
      repositoryId: initial.repository.repositoryId,
      repositoryRevisionId: initial.revision.repositoryRevisionId,
      configurationId: configuration.configurationId,
      mode: "full",
      root,
      scanOptions: SCAN_OPTIONS,
    });
    const before = await indexes.getSnapshot(context, first.index.indexVersionId);

    await writeFile(path.join(root, "modify.ts"), "export const value = 2;\n");
    await rm(path.join(root, "delete.ts"));
    await rm(path.join(root, "rename.ts"));
    await writeFile(path.join(root, "renamed.ts"), "export class Renamed {}\n");
    await writeFile(path.join(root, "create.py"), "def created():\n    return True\n");
    const changed = await prepareRevision(initial.repository.repositoryId);
    const second = await indexer.index(context, {
      commandId: crypto.randomUUID(),
      repositoryId: initial.repository.repositoryId,
      repositoryRevisionId: changed.revision.repositoryRevisionId,
      configurationId: configuration.configurationId,
      mode: "incremental",
      parentIndexVersionId: first.index.indexVersionId,
      root,
      scanOptions: SCAN_OPTIONS,
    });
    const after = await indexes.getSnapshot(context, second.index.indexVersionId);

    expect(after.files.map((file) => file.relativePath)).toEqual([
      "create.py",
      "modify.ts",
      "renamed.ts",
      "unchanged.ts",
    ]);
    expect(after.files.find((file) => file.relativePath === "unchanged.ts")?.sourceFileKey).toBe(
      before.files.find((file) => file.relativePath === "unchanged.ts")?.sourceFileKey,
    );
    expect(after.files.find((file) => file.relativePath === "modify.ts")?.contentHash).not.toBe(
      before.files.find((file) => file.relativePath === "modify.ts")?.contentHash,
    );
    expect(after.symbols.some((symbol) => symbol.relativePath === "delete.ts")).toBe(false);
    expect(after.symbols.some((symbol) => symbol.relativePath === "rename.ts")).toBe(false);
    expect(after.symbols.some((symbol) => symbol.relativePath === "renamed.ts")).toBe(true);
  });

  it("reconcile이 parent의 누락 파일과 drift를 실제 manifest로 교정하고 embedding 대기를 막지 않는다", async () => {
    await writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    await writeFile(path.join(root, "two.ts"), "export const two = 2;\n");
    const prepared = await prepareRevision();
    const configuration = await prepareConfiguration(prepared.repository.repositoryId, "pending");
    const indexer = new EvidenceIndexer(repositories, indexes, scanner, new EvidenceParser());
    const first = await indexer.index(context, {
      commandId: crypto.randomUUID(),
      repositoryId: prepared.repository.repositoryId,
      repositoryRevisionId: prepared.revision.repositoryRevisionId,
      configurationId: configuration.configurationId,
      mode: "full",
      root,
      scanOptions: SCAN_OPTIONS,
    });
    await database.query(
      "DELETE source_file WHERE organization_id = $organization_id AND index_version_id = $index_version_id AND relative_path = 'two.ts';",
      { organization_id: context.organizationId, index_version_id: first.index.indexVersionId },
    );

    const reconciled = await indexer.index(context, {
      commandId: crypto.randomUUID(),
      repositoryId: prepared.repository.repositoryId,
      repositoryRevisionId: prepared.revision.repositoryRevisionId,
      configurationId: configuration.configurationId,
      mode: "reconcile",
      parentIndexVersionId: first.index.indexVersionId,
      root,
      scanOptions: SCAN_OPTIONS,
    });
    const snapshot = await indexes.getSnapshot(context, reconciled.index.indexVersionId);

    expect(snapshot.files.map((file) => file.relativePath)).toEqual(["one.ts", "two.ts"]);
    expect(reconciled.index).toMatchObject({ status: "complete", current: true, embeddingStatus: "pending" });
  });

  it("동시 같은 command는 한 version으로 수렴하고 중복 snapshot·payload 충돌·완료 후 쓰기를 거부한다", async () => {
    await writeFile(path.join(root, "only.ts"), "export function only() { return true; }\n");
    const prepared = await prepareRevision();
    const configuration = await prepareConfiguration(prepared.repository.repositoryId);
    const indexer = new EvidenceIndexer(repositories, indexes, scanner, new EvidenceParser());
    const commandId = crypto.randomUUID();
    const request = {
      commandId,
      repositoryId: prepared.repository.repositoryId,
      repositoryRevisionId: prepared.revision.repositoryRevisionId,
      configurationId: configuration.configurationId,
      mode: "full",
      root,
      scanOptions: SCAN_OPTIONS,
    } as const;

    const [left, right] = await Promise.all([indexer.index(context, request), indexer.index(context, request)]);
    expect(left.index.indexVersionId).toBe(right.index.indexVersionId);
    expect(await repositories.listIndexes(context, prepared.repository.repositoryId)).toHaveLength(1);
    await expect(indexer.index(context, { ...request, commandId: crypto.randomUUID() })).rejects.toThrow(
      "같은 revision과 configuration",
    );
    await expect(
      repositories.startIndex(context, {
        commandId,
        repositoryId: prepared.repository.repositoryId,
        repositoryRevisionId: prepared.revision.repositoryRevisionId,
        configurationId: configuration.configurationId,
        mode: "reconcile",
        parentIndexVersionId: left.index.indexVersionId,
      }),
    ).rejects.toThrow("다른 index 명령");
    const evidence = await new EvidenceParser().parse({
      relativePath: "late.ts",
      language: "typescript",
      content: "export const late = true;\n",
      contentHash: "f".repeat(64),
    });
    await expect(
      indexes.stageFile(context, {
        indexVersionId: left.index.indexVersionId,
        relativePath: "late.ts",
        language: "typescript",
        size: 26,
        contentHash: "f".repeat(64),
        evidence,
      }),
    ).rejects.toThrow("building IndexVersion");
  });
});
