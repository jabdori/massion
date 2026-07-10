import { createHash } from "node:crypto";

import type { MassionDatabase, QueryExecutor } from "./database.js";
import { applyMigrations, defineMigration } from "./migrations.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

const DECLARATION_MIGRATION = defineMigration(
  "0001-declaration-version",
  `
DEFINE TABLE declaration_version SCHEMAFULL;
DEFINE FIELD project_id ON declaration_version TYPE string;
DEFINE FIELD revision ON declaration_version TYPE int;
DEFINE FIELD content_hash ON declaration_version TYPE string;
DEFINE FIELD content ON declaration_version TYPE object FLEXIBLE;
DEFINE FIELD applied_at ON declaration_version TYPE datetime;
DEFINE INDEX declaration_project_revision ON declaration_version FIELDS project_id, revision UNIQUE;
`,
);

export interface DeclarationVersion {
  readonly project_id: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly content: JsonValue;
  readonly applied_at: unknown;
}

export interface DeclarationApplyResult {
  readonly created: boolean;
  readonly declaration: DeclarationVersion;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
}

function hashDeclaration(content: JsonValue): string {
  return createHash("sha256").update(canonicalize(content)).digest("hex");
}

async function latest(executor: QueryExecutor, projectId: string): Promise<DeclarationVersion | undefined> {
  const [records] = await executor.query<[DeclarationVersion[]]>(
    "SELECT project_id, revision, content_hash, content, applied_at FROM declaration_version WHERE project_id = $project_id ORDER BY revision DESC LIMIT 1;",
    { project_id: projectId },
  );
  return records[0];
}

export class DeclarationStore {
  private constructor(private readonly database: MassionDatabase) {}

  public static async create(database: MassionDatabase): Promise<DeclarationStore> {
    await applyMigrations(database, [DECLARATION_MIGRATION]);
    return new DeclarationStore(database);
  }

  public async apply(projectId: string, content: JsonValue): Promise<DeclarationApplyResult> {
    if (!projectId.trim()) throw new Error("projectId는 비어 있을 수 없습니다");
    const contentHash = hashDeclaration(content);

    return await this.database.transaction(async (transaction) => {
      const current = await latest(transaction, projectId);
      if (current?.content_hash === contentHash) return { created: false, declaration: current };

      const revision = (current?.revision ?? 0) + 1;
      const [created] = await transaction.query<[DeclarationVersion[]]>(
        `CREATE declaration_version CONTENT {
          project_id: $project_id,
          revision: $revision,
          content_hash: $content_hash,
          content: $content,
          applied_at: time::now()
        } RETURN AFTER;`,
        { project_id: projectId, revision, content_hash: contentHash, content },
      );
      const declaration = created[0];
      if (!declaration) throw new Error("선언 version 생성 결과가 없습니다");
      return { created: true, declaration };
    });
  }

  public async list(projectId: string): Promise<DeclarationVersion[]> {
    const [records] = await this.database.query<[DeclarationVersion[]]>(
      "SELECT project_id, revision, content_hash, content, applied_at FROM declaration_version WHERE project_id = $project_id ORDER BY revision ASC;",
      { project_id: projectId },
    );
    return records;
  }
}
