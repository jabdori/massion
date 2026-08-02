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

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

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
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "src/allowed.ts"),
      `export function allowed() {\n  const marker = "${QUERY}";\n  return marker && related();\n}\n`,
    );
    await writeFile(path.join(root, "src/related.ts"), "export function related() { return 'related evidence'; }\n");
    await writeFile(path.join(root, "src/outside.ts"), "export function outside() { return 'outside evidence'; }\n");
    await writeFile(path.join(root, "src/unsupported.bin"), "not usable code evidence\n");
    await writeFile(path.join(root, "ISSUE.md"), "root issue evidence\n");
    await writeFile(path.join(root, "docs/ISSUE.md"), "nested issue evidence\n");
    await writeFile(path.join(root, "docs/ONLY.md"), "nested-only evidence\n");
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

  it("Work 재시도·scope·1-hop·revision 고정·prompt 무결성 경계를 함께 지킨다", { timeout: 15_000 }, async () => {
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
    const frozenSnapshot = await indexes.getSnapshot(context, first.brief.indexVersionId);
    const directReference = first.brief.references.find(
      (reference) => reference.kind === "code" && reference.relativePath === "src/allowed.ts",
    );
    const neighborReference = first.brief.references.find(
      (reference) => reference.kind === "code" && reference.relativePath === "src/related.ts",
    );
    const actualRelation = frozenSnapshot.relations.find(
      (relation) => relation.kind === "calls" && relation.targetText === "related",
    );
    if (directReference?.kind !== "code" || neighborReference?.kind !== "code" || !actualRelation) {
      throw new Error("Workspace knowledge provenance fixture가 없습니다");
    }
    expect(first.brief.snapshotChecksum).toBe(frozenSnapshot.checksum);
    expect(directReference.provenance).toMatchObject({
      selection: "direct-search",
      snapshotChecksum: frozenSnapshot.checksum,
      paths: [expect.objectContaining({ seed: expect.objectContaining({ referenceId: expect.any(String) }) })],
    });
    expect(neighborReference.provenance).toMatchObject({
      selection: "graph-neighbor",
      snapshotChecksum: frozenSnapshot.checksum,
      paths: [
        expect.objectContaining({
          seed: expect.objectContaining({ referenceId: expect.any(String), symbolKey: actualRelation.sourceSymbolKey }),
          relation: {
            relationId: actualRelation.relationId,
            relationKey: actualRelation.relationKey,
            kind: actualRelation.kind,
            sourceSymbolKey: actualRelation.sourceSymbolKey,
            targetSymbolKey: actualRelation.targetSymbolKey,
            targetText: actualRelation.targetText,
            resolved: true,
            relativePath: actualRelation.relativePath,
            startLine: actualRelation.startLine,
          },
        }),
      ],
    });

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
    expect(
      (await indexes.getSnapshot(context, scoped.brief.indexVersionId)).files.map((file) => file.relativePath),
    ).toEqual(["src/allowed.ts"]);
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
    expect(prompt.snippets.every((snippet) => snippet.citation.startsWith("/"))).toBe(true);
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

  it("첨부한 ignore 파일을 workspace 지식 범위로 준비한다", async () => {
    await writeFile(path.join(root, ".gitignore"), "history.txt\n");
    await writeFile(path.join(root, "history.txt"), `const marker = "${QUERY}";\n`);

    const prepared = await knowledge.prepare(context, {
      commandId: crypto.randomUUID(),
      workId: "work-ignored-attachment",
      workspaceId: "workspace-ignored-attachment",
      workspaceName: "Ignored attachment",
      root,
      query: QUERY,
      relativePaths: ["history.txt"],
    });

    expect(prepared.brief.status).toBe("ready");
    expect(prepared.brief.references).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "code", relativePath: "history.txt" })]),
    );
  });

  it("자연어 질의의 정확한 상대 경로만 동결된 snapshot 청크로 선택한다", { timeout: 15_000 }, async () => {
    await writeFile(path.join(root, ".gitignore"), "history.txt\n");
    await writeFile(path.join(root, "history.txt"), "ignored attachment evidence\n");
    const cases = [
      { name: "루트 파일", query: "(ISSUE.md)를 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "중첩 파일", query: "`docs/ISSUE.md`, 계약을 확인해주세요.", paths: ["docs/ISSUE.md"] },
      { name: "조사 의", query: "ISSUE.md의 incident priority report 순서 오류를 해결해 주세요.", paths: ["ISSUE.md"] },
      { name: "조사 을", query: "ISSUE.md을 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 를", query: "ISSUE.md를 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 은", query: "ISSUE.md은 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 는", query: "ISSUE.md는 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 이", query: "ISSUE.md이 맞습니다.", paths: ["ISSUE.md"] },
      { name: "조사 가", query: "ISSUE.md가 맞습니다.", paths: ["ISSUE.md"] },
      { name: "조사 과", query: "ISSUE.md과 비교해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 와", query: "ISSUE.md와 비교해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 에", query: "ISSUE.md에 기록해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 에서", query: "ISSUE.md에서 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 으로", query: "ISSUE.md으로 이동해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 로", query: "ISSUE.md로 이동해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 부터", query: "ISSUE.md부터 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 까지", query: "ISSUE.md까지 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 만", query: "ISSUE.md만 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "조사 도", query: "ISSUE.md도 확인해주세요.", paths: ["ISSUE.md"] },
      { name: "없는 파일", query: "MISSING.md를 확인해주세요.", paths: [] },
      { name: "다른 디렉터리 basename", query: "ONLY.md를 확인해주세요.", paths: [] },
      { name: "붙은 명사", query: "ISSUE.md파일을 확인해주세요.", paths: [] },
      { name: "조사 뒤 명사", query: "ISSUE.md의파일을 확인해주세요.", paths: [] },
      { name: "비슷한 파일명 접두사", query: "backup-ISSUE.md를 확인해주세요.", paths: [] },
      { name: "점 확장자 접미사", query: "ISSUE.md.bak를 확인해주세요.", paths: [] },
      { name: "점 파일명 접두사", query: "backup.ISSUE.md를 확인해주세요.", paths: [] },
      { name: "점 파일명 접두사 2", query: "foo.ISSUE.md를 확인해주세요.", paths: [] },
      { name: "절대 경로", query: "/ISSUE.md를 확인해주세요.", paths: [] },
      { name: "상위 디렉터리", query: "../ISSUE.md를 확인해주세요.", paths: [] },
      { name: "NUL", query: "\0ISSUE.md를 확인해주세요.", paths: [] },
      { name: "비정규화 경로", query: "docs/./ISSUE.md를 확인해주세요.", paths: [] },
      { name: "디렉터리", query: "docs를 확인해주세요.", paths: [] },
    ] as const;

    for (const testCase of cases) {
      const prepared = await knowledge.prepare(context, {
        commandId: crypto.randomUUID(),
        workId: `work-exact-path-${testCase.name}`,
        workspaceId: "workspace-exact-path",
        workspaceName: "Exact path fixture",
        root,
        query: testCase.query,
      });
      const paths = prepared.brief.references.flatMap((reference) =>
        reference.kind === "code" ? [reference.relativePath] : [],
      );

      expect(paths, testCase.name).toEqual(testCase.paths);
      expect(prepared.brief.status, testCase.name).toBe(testCase.paths.length === 0 ? "no_match" : "ready");
      if (testCase.paths.length > 0) {
        expect(
          prepared.brief.references.every(
            (reference) => reference.kind === "code" && reference.provenance.selection === "scope",
          ),
        ).toBe(true);
      }
    }

    const attached = await knowledge.prepare(context, {
      commandId: crypto.randomUUID(),
      workId: "work-exact-path-ignored-attachment",
      workspaceId: "workspace-exact-path",
      workspaceName: "Exact path fixture",
      root,
      query: "history.txt를 확인해주세요.",
      relativePaths: ["history.txt"],
    });
    expect(
      (await indexes.getSnapshot(context, attached.brief.indexVersionId)).files.map((file) => file.relativePath),
    ).toEqual(["history.txt"]);
    expect(attached.brief.references).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "code", relativePath: "history.txt" })]),
    );
  });

  it("동결된 graph provenance를 바꾸면 EvidenceBrief checksum 검증이 fail-closed한다", async () => {
    const prepared = await knowledge.prepare(context, {
      commandId: crypto.randomUUID(),
      workId: "work-provenance-tamper",
      workspaceId: "workspace-provenance-tamper",
      workspaceName: "Provenance tamper",
      root,
      query: QUERY,
    });
    const references = prepared.brief.references.map((reference) => {
      if (reference.kind !== "code" || reference.provenance.selection !== "graph-neighbor") return reference;
      const firstPath = reference.provenance.paths[0];
      if (!firstPath?.relation) throw new Error("변조 확인용 graph relation이 없습니다");
      return {
        ...reference,
        provenance: {
          ...reference.provenance,
          paths: [
            {
              ...firstPath,
              relation: { ...firstPath.relation, relationId: "tampered-relation-id" },
            },
          ],
        },
      };
    });
    await database.query(
      "UPDATE evidence_brief SET references_json = $references_json WHERE organization_id = $organization_id AND evidence_brief_id = $evidence_brief_id;",
      {
        organization_id: context.organizationId,
        evidence_brief_id: prepared.brief.evidenceBriefId,
        references_json: JSON.stringify(references),
      },
    );

    await expect(briefs.getBrief(context, prepared.brief.evidenceBriefId)).rejects.toThrow("checksum");
  });

  it("migration 전 ready automatic Brief는 원본을 보존한 새 provenance 버전으로 안전하게 복구한다", async () => {
    const base = {
      workspaceId: "workspace-legacy-brief",
      workspaceName: "Legacy brief recovery",
      root,
      query: QUERY,
    };
    const prepared = await knowledge.prepare(context, {
      ...base,
      commandId: crypto.randomUUID(),
      workId: "work-legacy-brief",
    });
    const legacyReferences = prepared.brief.references.map((reference) => {
      if (reference.kind !== "code") return reference;
      return Object.fromEntries(Object.entries(reference).filter(([key]) => key !== "provenance"));
    });
    const legacyChecksum = checksum({
      workId: prepared.brief.workId,
      repositoryId: prepared.brief.repositoryId,
      repositoryRevisionId: prepared.brief.repositoryRevisionId,
      indexVersionId: prepared.brief.indexVersionId,
      configurationChecksum: prepared.brief.configurationChecksum,
      query: prepared.brief.query,
      status: prepared.brief.status,
      references: legacyReferences,
      claims: prepared.brief.claims,
      scopeChecksum: prepared.brief.scopeChecksum,
    });
    await database.query(
      "UPDATE evidence_brief SET snapshot_checksum = NONE, automatic_key = $automatic_key, references_json = $references_json, checksum = $checksum WHERE organization_id = $organization_id AND evidence_brief_id = $evidence_brief_id;",
      {
        organization_id: context.organizationId,
        evidence_brief_id: prepared.brief.evidenceBriefId,
        automatic_key: `${context.organizationId}:${prepared.brief.workId}`,
        references_json: canonicalJson(legacyReferences),
        checksum: legacyChecksum,
      },
    );
    await database.query(`
      DEFINE EVENT legacy_brief_upgrade_immutable_test ON TABLE evidence_brief
      WHEN $event IN ['UPDATE', 'DELETE']
      THEN { THROW 'EvidenceBrief는 immutable입니다'; };
    `);
    await writeFile(path.join(root, "src/allowed.ts"), "export const changedAfterLegacyBrief = true;\n");

    const recovered = await knowledge.prepare(context, {
      ...base,
      commandId: crypto.randomUUID(),
      workId: prepared.brief.workId,
    });
    expect(recovered.brief.evidenceBriefId).not.toBe(prepared.brief.evidenceBriefId);
    expect(recovered.brief.indexVersionId).toBe(prepared.brief.indexVersionId);
    expect(recovered.brief.references.map((reference) => reference.referenceId)).toEqual(
      legacyReferences.map((reference) => String(reference.referenceId)),
    );
    expect(recovered.brief.snapshotChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      recovered.brief.references.every(
        (reference) =>
          reference.kind !== "code" || reference.provenance.snapshotChecksum === recovered.brief.snapshotChecksum,
      ),
    ).toBe(true);
    const preservedLegacy = await briefs.getBrief(context, prepared.brief.evidenceBriefId);
    expect(preservedLegacy).toMatchObject({
      evidenceBriefId: prepared.brief.evidenceBriefId,
      checksum: legacyChecksum,
    });
    expect(preservedLegacy.snapshotChecksum).toBeUndefined();
    await database.query("REMOVE EVENT legacy_brief_upgrade_immutable_test ON TABLE evidence_brief;");

    const tampered = await knowledge.prepare(context, {
      ...base,
      commandId: crypto.randomUUID(),
      workId: "work-legacy-tampered",
    });
    await database.query(
      "UPDATE evidence_brief SET snapshot_checksum = NONE, checksum = $checksum WHERE organization_id = $organization_id AND evidence_brief_id = $evidence_brief_id;",
      {
        organization_id: context.organizationId,
        evidence_brief_id: tampered.brief.evidenceBriefId,
        checksum: "0".repeat(64),
      },
    );
    await expect(
      knowledge.prepare(context, {
        ...base,
        commandId: crypto.randomUUID(),
        workId: tampered.brief.workId,
      }),
    ).rejects.toThrow("checksum");
  });
});
