import { randomUUID } from "node:crypto";

import { applyMigrations, defineMigration, type MassionDatabase } from "@massion/storage";

const OPERATION_QUEUE_MIGRATION = defineMigration(
  "0021-operation-queue",
  `
DEFINE TABLE IF NOT EXISTS operation_action SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS action_id ON operation_action TYPE string;
DEFINE FIELD IF NOT EXISTS dedupe_key ON operation_action TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON operation_action TYPE string;
DEFINE FIELD IF NOT EXISTS payload_json ON operation_action TYPE string;
DEFINE FIELD IF NOT EXISTS state ON operation_action TYPE string ASSERT $value IN ['pending', 'leased', 'succeeded', 'failed'];
DEFINE FIELD IF NOT EXISTS attempts ON operation_action TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS max_attempts ON operation_action TYPE int ASSERT $value >= 1 AND $value <= 20;
DEFINE FIELD IF NOT EXISTS available_at ON operation_action TYPE datetime;
DEFINE FIELD IF NOT EXISTS lease_owner ON operation_action TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_generation ON operation_action TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON operation_action TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS error_category ON operation_action TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON operation_action TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON operation_action TYPE datetime;
DEFINE INDEX IF NOT EXISTS operation_action_id ON operation_action FIELDS action_id UNIQUE;
DEFINE INDEX IF NOT EXISTS operation_action_dedupe ON operation_action FIELDS dedupe_key UNIQUE;
`,
);

export interface OperationAction {
  readonly actionId: string;
  readonly dedupeKey: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly state: "pending" | "leased" | "succeeded" | "failed";
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseGeneration: number;
  readonly leaseOwner?: string;
}

interface ActionRow {
  readonly action_id: string;
  readonly dedupe_key: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly state: OperationAction["state"];
  readonly attempts: number;
  readonly max_attempts: number;
  readonly lease_generation: number;
  readonly lease_owner?: string;
}

function view(row: ActionRow): OperationAction {
  return {
    actionId: row.action_id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseGeneration: row.lease_generation,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
  };
}

export class OperationQueue {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly leaseMs: number,
  ) {}

  public static async create(
    database: MassionDatabase,
    options: { readonly leaseMs?: number } = {},
  ): Promise<OperationQueue> {
    const leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000)
      throw new Error("operation lease 시간이 유효하지 않습니다");
    await applyMigrations(database, [OPERATION_QUEUE_MIGRATION]);
    return new OperationQueue(database, leaseMs);
  }

  public async enqueue(input: {
    readonly dedupeKey: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly maxAttempts?: number;
    readonly delayMs?: number;
  }): Promise<OperationAction> {
    if (!/^[a-z0-9][a-z0-9:._-]{2,255}$/u.test(input.dedupeKey))
      throw new Error("operation dedupe key가 유효하지 않습니다");
    if (!/^[a-z][a-z0-9-]{2,63}$/u.test(input.kind)) throw new Error("operation kind가 유효하지 않습니다");
    const payloadJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadJson) > 64 * 1024) throw new Error("operation payload byte 상한을 초과했습니다");
    const maxAttempts = input.maxAttempts ?? 5;
    const delayMs = input.delayMs ?? 0;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
      throw new Error("operation 최대 시도 횟수가 유효하지 않습니다");
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 86_400_000)
      throw new Error("operation 지연 시간이 유효하지 않습니다");
    return await this.database.transaction(async (transaction) => {
      const [existing] = await transaction.query<[ActionRow[]]>(
        "SELECT * OMIT id FROM operation_action WHERE dedupe_key = $dedupe_key LIMIT 1;",
        { dedupe_key: input.dedupeKey },
      );
      if (existing[0]) return view(existing[0]);
      const actionId = randomUUID();
      const [created] = await transaction.query<[ActionRow[]]>(
        "CREATE operation_action CONTENT { action_id: $action_id, dedupe_key: $dedupe_key, kind: $kind, payload_json: $payload_json, state: 'pending', attempts: 0, max_attempts: $max_attempts, available_at: $available_at, lease_owner: NONE, lease_generation: 0, lease_expires_at: NONE, error_category: NONE, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          action_id: actionId,
          dedupe_key: input.dedupeKey,
          kind: input.kind,
          payload_json: payloadJson,
          max_attempts: maxAttempts,
          available_at: new Date(Date.now() + delayMs),
        },
      );
      if (!created[0]) throw new Error("operation action을 생성하지 못했습니다");
      return view(created[0]);
    });
  }

  public async claim(owner: string): Promise<OperationAction | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(owner))
      throw new Error("operation lease owner가 유효하지 않습니다");
    return await this.database.transaction(async (transaction) => {
      const [selected] = await transaction.query<[ActionRow[]]>(
        "SELECT * OMIT id FROM operation_action WHERE ((state = 'pending' AND available_at <= time::now()) OR (state = 'leased' AND lease_expires_at <= time::now())) AND attempts < max_attempts ORDER BY available_at ASC, created_at ASC LIMIT 1;",
      );
      const candidate = selected[0];
      if (!candidate) return undefined;
      const generation = candidate.lease_generation + 1;
      const [claimed] = await transaction.query<[ActionRow[]]>(
        "UPDATE operation_action SET state = 'leased', attempts += 1, lease_owner = $owner, lease_generation = $generation, lease_expires_at = $expires_at, updated_at = time::now() WHERE action_id = $action_id AND lease_generation = $previous_generation AND ((state = 'pending' AND available_at <= time::now()) OR (state = 'leased' AND lease_expires_at <= time::now())) RETURN AFTER;",
        {
          owner,
          generation,
          expires_at: new Date(Date.now() + this.leaseMs),
          action_id: candidate.action_id,
          previous_generation: candidate.lease_generation,
        },
      );
      return claimed[0] ? view(claimed[0]) : undefined;
    });
  }

  public async complete(actionId: string, leaseGeneration: number, owner: string): Promise<void> {
    const [updated] = await this.database.query<[ActionRow[]]>(
      "UPDATE operation_action SET state = 'succeeded', lease_owner = NONE, lease_expires_at = NONE, error_category = NONE, updated_at = time::now() WHERE action_id = $action_id AND state = 'leased' AND lease_generation = $generation AND lease_owner = $owner RETURN AFTER;",
      { action_id: actionId, generation: leaseGeneration, owner },
    );
    if (!updated[0]) {
      const current = await this.get(actionId);
      if (current?.state === "succeeded") return;
      throw new Error("operation lease가 완료 조건과 일치하지 않습니다");
    }
  }

  public async fail(
    actionId: string,
    leaseGeneration: number,
    owner: string,
    category: string,
    delayMs: number,
  ): Promise<void> {
    if (!/^[a-z][a-z0-9-]{2,63}$/u.test(category)) throw new Error("operation 오류 category가 유효하지 않습니다");
    const current = await this.get(actionId);
    if (!current || current.state !== "leased") throw new Error("실패 처리할 operation lease가 없습니다");
    const terminal = current.attempts >= current.maxAttempts;
    const [updated] = await this.database.query<[ActionRow[]]>(
      "UPDATE operation_action SET state = $state, available_at = $available_at, lease_owner = NONE, lease_expires_at = NONE, error_category = $category, updated_at = time::now() WHERE action_id = $action_id AND state = 'leased' AND lease_generation = $generation AND lease_owner = $owner RETURN AFTER;",
      {
        state: terminal ? "failed" : "pending",
        available_at: new Date(Date.now() + delayMs),
        category,
        action_id: actionId,
        generation: leaseGeneration,
        owner,
      },
    );
    if (!updated[0]) throw new Error("operation lease가 실패 조건과 일치하지 않습니다");
  }

  public async get(actionId: string): Promise<OperationAction | undefined> {
    const [rows] = await this.database.query<[ActionRow[]]>(
      "SELECT * OMIT id FROM operation_action WHERE action_id = $action_id LIMIT 1;",
      { action_id: actionId },
    );
    return rows[0] ? view(rows[0]) : undefined;
  }
}
