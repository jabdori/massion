import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  CodeGraphService,
  CodeSearchService,
  EvidenceBriefStore,
  EvidenceIndexer,
  EvidenceParser,
  EvidencePromptMaterializer,
  IndexStore,
  RepositoryRevisionCollector,
  RepositoryScanner,
  RepositoryStore,
  WorkspaceKnowledgeService,
} from "./index.js";

const SCAN_OPTIONS = { include: ["**/*"], exclude: [], maxFileBytes: 128 * 1_024 } as const;
const QUERY = "KNOWLEDGE_MARKER_8329";

describe("Workspace 기반 자동 Evidence 지식 준비", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let root: string;
  let repositories: RepositoryStore;
  let indexes: IndexStore;
  let briefs: EvidenceBriefStore;
  let knowledge: WorkspaceKnowledgeService;
  let materializer: EvidencePromptMaterializer;

  async function writeFixture(): Promise<void> {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src/allowed.ts"),
      `export function allowed() {\n  const marker = "${QUERY}";\n  return marker && related();\n}\n`,
    );
    await writeFile(path.join(root, "src/related.ts"), "export function related() { return 'related evidence'; }\n");
    await writeFile(path.join(root, "src/outside.ts"), "export function outside() { return 'outside evidence'; }\n");
    await writeFile(path.join(root, "src/unsupported.bin"), "not usable code evidence\n");
  }

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "knowledge@example.com", displayName: "Knowledge" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    root = await mkdtemp(path.join(os.tmpdir(), "massion-knowledge-"));
    await writeFixture();

    const scanner = new RepositoryScanner();
    const parser = new EvidenceParser();
    repositories = await RepositoryStore.create(database, organizations);
    indexes = await IndexStore.create(database, organizations);
    briefs = await EvidenceBriefStore.create(database, repositories, indexes);
    knowledge = new WorkspaceKnowledgeService(
      repositories,
      indexes,
      new RepositoryRevisionCollector(scanner),
      new EvidenceIndexer(repositories, indexes, scanner, parser),
      await CodeSearchService.create(database, repositories, indexes),
      new CodeGraphService(repositories, indexes),
      briefs,
      { scanOptions: SCAN_OPTIONS, parserBundleVersion: parser.bundleVersion },
    );
    materializer = new EvidencePromptMaterializer(repositories, indexes, briefs);
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("Work 재시도·scope·1-hop·revision 고정·prompt 무결성 경계를 함께 지킨다", async () => {
    const base = {
      workId: "work-unscoped",
      workspaceId: "workspace-knowledge",
      workspaceName: "Knowledge fixture",
      root,
      query: QUERY,
    };
    const first = await knowledge.prepare(context, { ...base, commandId: crypto.randomUUID() });
    await rm(root, { recursive: true, force: true });
    const repeated = await knowledge.prepare(context, { ...base, commandId: crypto.randomUUID() });

    expect(first.brief.status).toBe("ready");
    expect(repeated.brief.evidenceBriefId).toBe(first.brief.evidenceBriefId);
    expect(repeated.brief.indexVersionId).toBe(first.brief.indexVersionId);
    await writeFixture();
    expect(first.brief.references.map((reference) => reference.kind === "code" && reference.relativePath)).toEqual(
      expect.arrayContaining(["src/allowed.ts", "src/related.ts"]),
    );

    await expect(
      knowledge.prepare(context, {
        ...base,
        commandId: crypto.randomUUID(),
        relativePaths: ["src/allowed.ts"],
      }),
    ).rejects.toThrow("scope");

    const scoped = await knowledge.prepare(context, {
      ...base,
      commandId: crypto.randomUUID(),
      workId: "work-scoped",
      relativePaths: ["src/allowed.ts"],
    });
    expect(scoped.brief.status).toBe("ready");
    expect(scoped.brief.references).not.toHaveLength(0);
    expect(
      scoped.brief.references.every(
        (reference) => reference.kind === "code" && reference.relativePath === "src/allowed.ts",
      ),
    ).toBe(true);
    await expect(
      knowledge.prepare(context, {
        ...base,
        commandId: crypto.randomUUID(),
        workId: "work-unusable-scope",
        relativePaths: ["src/unsupported.bin"],
      }),
    ).rejects.toThrow("usable chunk");
    expect(await briefs.findAutomaticByWork(context, "work-unusable-scope")).toBeUndefined();
    const noMatch = await knowledge.prepare(context, {
      ...base,
      commandId: crypto.randomUUID(),
      workId: "work-unscoped-no-match",
      query: "NO_MATCH_QUERY_940851",
    });
    expect(noMatch.brief).toMatchObject({ status: "no_match", references: [] });
    await expect(
      materializer.verifyNoMatch(context, {
        workId: noMatch.brief.workId,
        evidenceBriefId: noMatch.brief.evidenceBriefId,
      }),
    ).resolves.toMatchObject({ status: "no_match", checksum: noMatch.brief.checksum });
    await database.query(
      "UPDATE evidence_brief SET checksum = $checksum WHERE organization_id = $organization_id AND evidence_brief_id = $evidence_brief_id;",
      {
        checksum: "0".repeat(64),
        organization_id: context.organizationId,
        evidence_brief_id: noMatch.brief.evidenceBriefId,
      },
    );
    await expect(
      materializer.verifyNoMatch(context, {
        workId: noMatch.brief.workId,
        evidenceBriefId: noMatch.brief.evidenceBriefId,
      }),
    ).rejects.toThrow("checksum");

    await writeFile(
      path.join(root, "src/allowed.ts"),
      `export function allowed() {\n  const marker = "${QUERY}";\n  return marker && related() && "changed";\n}\n`,
    );
    const changed = await knowledge.prepare(context, {
      ...base,
      commandId: crypto.randomUUID(),
      workId: "work-changed",
    });
    expect(changed.brief.indexVersionId).not.toBe(first.brief.indexVersionId);
    expect((await briefs.getBrief(context, first.brief.evidenceBriefId)).indexVersionId).toBe(
      first.brief.indexVersionId,
    );

    const prompt = await materializer.materialize(context, {
      workId: first.brief.workId,
      evidenceBriefId: first.brief.evidenceBriefId,
    });
    const references = new Map(first.brief.references.map((reference) => [reference.referenceId, reference]));
    expect(prompt.indexVersionId).toBe(first.brief.indexVersionId);
    expect(prompt.estimatedTokens).toBeLessThanOrEqual(24_000);
    expect(prompt.snippets).not.toHaveLength(0);
    for (const snippet of prompt.snippets) {
      expect(createHash("sha256").update(snippet.content).digest("hex")).toBe(
        references.get(snippet.referenceId)?.contentHash,
      );
    }
    await expect(
      materializer.materialize(context, {
        workId: first.brief.workId,
        evidenceBriefId: first.brief.evidenceBriefId,
        maxEstimatedTokens: 1,
      }),
    ).rejects.toThrow("snippet");
  });
});
