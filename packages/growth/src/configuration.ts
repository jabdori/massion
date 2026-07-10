import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  type ConfigureGrowthInput,
  type GrowthConfigurationAuthorizer,
  type GrowthConfigurationGateway,
  type GrowthConfigurationSubject,
  type GrowthConfigurationVersion,
  validateGrowthConfigurationInput,
} from "./contracts.js";
import { GROWTH_CONFIGURATION_MIGRATION } from "./schema.js";

interface ConfigurationRecord {
  readonly configuration_version_id: string;
  readonly organization_id: string;
  readonly subject_type: "organization" | "user";
  readonly subject_id?: string;
  readonly version: number;
  readonly previous_version_id?: string;
  readonly reflection_enabled: boolean;
  readonly adoption_mode: "review" | "auto";
  readonly status: "active" | "superseded";
  readonly governance_decision_id: string;
  readonly checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
  readonly activated_at: unknown;
  readonly superseded_at?: unknown;
}

interface OrganizationRecord {
  readonly organization_id: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function subjectKey(subject: GrowthConfigurationSubject): string {
  return subject.type === "organization" ? "organization" : `user:${subject.userId}`;
}

function iso(value: unknown): string {
  if (value && typeof value === "object" && "toISOString" in value) {
    const converter = (value as { toISOString?: unknown }).toISOString;
    if (typeof converter === "function") return String(converter.call(value));
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("Growth configuration datetime이 유효하지 않습니다");
  return parsed.toISOString();
}

function toVersion(record: ConfigurationRecord): GrowthConfigurationVersion {
  const subject: GrowthConfigurationSubject =
    record.subject_type === "organization"
      ? { type: "organization" }
      : { type: "user", userId: record.subject_id ?? "" };
  return {
    configurationVersionId: record.configuration_version_id,
    organizationId: record.organization_id,
    subject,
    version: record.version,
    ...(record.previous_version_id ? { previousVersionId: record.previous_version_id } : {}),
    reflectionEnabled: record.reflection_enabled,
    adoptionMode: record.adoption_mode,
    status: record.status,
    governanceDecisionId: record.governance_decision_id,
    checksum: record.checksum,
    commandId: record.command_id,
    createdByUserId: record.created_by_user_id,
    createdAt: iso(record.created_at),
    activatedAt: iso(record.activated_at),
    ...(record.superseded_at ? { supersededAt: iso(record.superseded_at) } : {}),
  };
}

async function findByCommand(
  executor: QueryExecutor,
  organizationId: string,
  commandId: string,
): Promise<ConfigurationRecord | undefined> {
  const [records] = await executor.query<[ConfigurationRecord[]]>(
    "SELECT * FROM growth_configuration_version WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
    { organization_id: organizationId, command_id: commandId },
  );
  return records[0];
}

async function findActive(
  executor: QueryExecutor,
  organizationId: string,
  key: string,
): Promise<ConfigurationRecord | undefined> {
  const [records] = await executor.query<[ConfigurationRecord[]]>(
    "SELECT * FROM growth_configuration_version WHERE active_guard_key = $active_guard_key LIMIT 1;",
    { active_guard_key: `${organizationId}:${key}` },
  );
  const record = records[0];
  if (record && (record.organization_id !== organizationId || subjectKey(toVersion(record).subject) !== key)) {
    throw new Error("Growth configuration active guard가 tenant 또는 subject와 일치하지 않습니다");
  }
  return record;
}

function assertReplay(record: ConfigurationRecord, requestHash: string): GrowthConfigurationVersion {
  if (record.request_hash !== requestHash) throw new Error("같은 commandId에 다른 payload를 사용할 수 없습니다");
  return toVersion(record);
}

export class GrowthConfigurationStore implements GrowthConfigurationGateway {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly authorizer: GrowthConfigurationAuthorizer,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    authorizer: GrowthConfigurationAuthorizer,
  ): Promise<GrowthConfigurationStore> {
    await applyMigrations(database, [GROWTH_CONFIGURATION_MIGRATION]);
    const store = new GrowthConfigurationStore(database, organizations, authorizer);
    await store.bootstrapDefaults();
    return store;
  }

  public async configure(
    context: TenantContext,
    unvalidated: ConfigureGrowthInput,
  ): Promise<GrowthConfigurationVersion> {
    const input = validateGrowthConfigurationInput(unvalidated);
    const requestHash = sha256(canonicalJson(input));
    await this.organizations.verifyTenantContext(context);
    const replayed = await findByCommand(this.database, context.organizationId, input.commandId);
    if (replayed) return assertReplay(replayed, requestHash);

    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      if (input.subject.type === "user") {
        await this.organizations.verifyOrganizationMember(input.subject.userId, context.organizationId, transaction);
      }
      const concurrentReplay = await findByCommand(transaction, context.organizationId, input.commandId);
      if (concurrentReplay) return assertReplay(concurrentReplay, requestHash);

      const key = subjectKey(input.subject);
      const current = await findActive(transaction, context.organizationId, key);
      if (input.expectedVersion !== undefined && current?.version !== input.expectedVersion) {
        throw new Error("Growth configuration version precondition이 일치하지 않습니다");
      }
      const decision = await this.authorizer.authorizeConfiguration(context, input, transaction);
      const configurationVersionId = randomUUID();
      const version = (current?.version ?? 0) + 1;
      const checksum = sha256(
        canonicalJson({
          configurationVersionId,
          organizationId: context.organizationId,
          subject: input.subject,
          version,
          previousVersionId: current?.configuration_version_id,
          reflectionEnabled: input.reflectionEnabled,
          adoptionMode: input.adoptionMode,
          governanceDecisionId: decision.governanceDecisionId,
        }),
      );

      if (current) {
        await transaction.query(
          "UPDATE growth_configuration_version SET status = 'superseded', active_guard_key = NONE, superseded_at = time::now() WHERE organization_id = $organization_id AND configuration_version_id = $configuration_version_id;",
          {
            organization_id: context.organizationId,
            configuration_version_id: current.configuration_version_id,
          },
        );
        await this.recordEvent(transaction, {
          organizationId: context.organizationId,
          configurationVersionId: current.configuration_version_id,
          commandId: input.commandId,
          eventType: "superseded",
          requestHash,
          actorUserId: context.userId,
        });
      }

      const [created] = await transaction.query<[ConfigurationRecord[]]>(
        `CREATE growth_configuration_version CONTENT {
          configuration_version_id: $configuration_version_id,
          organization_id: $organization_id,
          subject_type: $subject_type,
          subject_id: $subject_id,
          subject_key: $subject_key,
          version: $version,
          previous_version_id: $previous_version_id,
          status: 'active',
          reflection_enabled: $reflection_enabled,
          adoption_mode: $adoption_mode,
          command_id: $command_id,
          request_hash: $request_hash,
          governance_decision_id: $governance_decision_id,
          checksum: $checksum,
          active_guard_key: $active_guard_key,
          created_by_user_id: $created_by_user_id,
          created_at: time::now(),
          activated_at: time::now(),
          superseded_at: NONE
        } RETURN AFTER;`,
        {
          configuration_version_id: configurationVersionId,
          organization_id: context.organizationId,
          subject_type: input.subject.type,
          subject_id: input.subject.type === "user" ? input.subject.userId : undefined,
          subject_key: key,
          version,
          previous_version_id: current?.configuration_version_id,
          reflection_enabled: input.reflectionEnabled,
          adoption_mode: input.adoptionMode,
          command_id: input.commandId,
          request_hash: requestHash,
          governance_decision_id: decision.governanceDecisionId,
          checksum,
          active_guard_key: `${context.organizationId}:${key}`,
          created_by_user_id: context.userId,
        },
      );
      const record = created[0];
      if (!record) throw new Error("Growth configuration 생성 결과가 없습니다");
      await this.recordEvent(transaction, {
        organizationId: context.organizationId,
        configurationVersionId,
        commandId: input.commandId,
        eventType: "configured",
        requestHash,
        actorUserId: context.userId,
      });
      return toVersion(record);
    });
  }

  public async resolve(context: TenantContext, requesterUserId?: string): Promise<GrowthConfigurationVersion> {
    await this.organizations.verifyTenantContext(context);
    if (requesterUserId) {
      const [memberships] = await this.database.query<[Array<{ status: string }>]>(
        "SELECT status FROM membership WHERE organization_id = $organization_id AND user_id = $user_id AND status = 'active' LIMIT 1;",
        { organization_id: context.organizationId, user_id: requesterUserId },
      );
      if (memberships[0]) {
        const userConfiguration = await findActive(
          this.database,
          context.organizationId,
          subjectKey({ type: "user", userId: requesterUserId }),
        );
        if (userConfiguration) return toVersion(userConfiguration);
      }
    }
    let organizationConfiguration = await findActive(this.database, context.organizationId, "organization");
    if (!organizationConfiguration) {
      await this.ensureOrganizationDefault(context.organizationId);
      organizationConfiguration = await findActive(this.database, context.organizationId, "organization");
    }
    if (!organizationConfiguration) throw new Error("활성 조직 Growth configuration을 찾을 수 없습니다");
    return toVersion(organizationConfiguration);
  }

  private async bootstrapDefaults(): Promise<void> {
    const [organizations] = await this.database.query<[OrganizationRecord[]]>(
      "SELECT organization_id FROM organization ORDER BY organization_id ASC;",
    );
    for (const organization of organizations) {
      await this.ensureOrganizationDefault(organization.organization_id);
    }
  }

  private async ensureOrganizationDefault(organizationId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      if (await findActive(transaction, organizationId, "organization")) return;
      const configurationVersionId = randomUUID();
      const commandId = `bootstrap-growth-configuration:${organizationId}`;
      const requestHash = sha256(
        canonicalJson({
          commandId,
          subject: { type: "organization" },
          reflectionEnabled: true,
          adoptionMode: "review",
        }),
      );
      const replayed = await findByCommand(transaction, organizationId, commandId);
      if (replayed) return;
      const checksum = sha256(
        canonicalJson({
          configurationVersionId,
          organizationId,
          subject: { type: "organization" },
          version: 1,
          reflectionEnabled: true,
          adoptionMode: "review",
          governanceDecisionId: "system-bootstrap",
        }),
      );
      await transaction.query(
        `CREATE growth_configuration_version CONTENT {
          configuration_version_id: $configuration_version_id,
          organization_id: $organization_id,
          subject_type: 'organization',
          subject_id: NONE,
          subject_key: 'organization',
          version: 1,
          previous_version_id: NONE,
          status: 'active',
          reflection_enabled: true,
          adoption_mode: 'review',
          command_id: $command_id,
          request_hash: $request_hash,
          governance_decision_id: 'system-bootstrap',
          checksum: $checksum,
          active_guard_key: $active_guard_key,
          created_by_user_id: 'system-bootstrap',
          created_at: time::now(),
          activated_at: time::now(),
          superseded_at: NONE
        };`,
        {
          configuration_version_id: configurationVersionId,
          organization_id: organizationId,
          command_id: commandId,
          request_hash: requestHash,
          checksum,
          active_guard_key: `${organizationId}:organization`,
        },
      );
      await this.recordEvent(transaction, {
        organizationId,
        configurationVersionId,
        commandId,
        eventType: "configured",
        requestHash,
        actorUserId: "system-bootstrap",
      });
    });
  }

  private async recordEvent(
    executor: QueryExecutor,
    input: {
      readonly organizationId: string;
      readonly configurationVersionId: string;
      readonly commandId: string;
      readonly eventType: "configured" | "superseded";
      readonly requestHash: string;
      readonly actorUserId: string;
    },
  ): Promise<void> {
    await executor.query(
      "CREATE growth_configuration_event CONTENT { event_id: $event_id, organization_id: $organization_id, configuration_version_id: $configuration_version_id, command_id: $command_id, event_type: $event_type, request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: input.organizationId,
        configuration_version_id: input.configurationVersionId,
        command_id: input.commandId,
        event_type: input.eventType,
        request_hash: input.requestHash,
        payload_json: canonicalJson({ configurationVersionId: input.configurationVersionId }),
        actor_user_id: input.actorUserId,
      },
    );
  }
}
