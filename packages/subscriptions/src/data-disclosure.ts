import { randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { SUBSCRIPTION_DATA_DISCLOSURE_MIGRATION } from "./schema.js";

export interface SubscriptionDataDisclosure {
  readonly providerId: "openai-codex";
  readonly version: "openai-codex-data-controls-2026-07-13";
  readonly title: string;
  readonly summary: string;
  readonly documentationUrl: string;
}

export interface SubscriptionDataDisclosureAcknowledgement {
  readonly providerId: string;
  readonly version: string;
  readonly acknowledgedAt: string;
}

interface DisclosureRecord {
  readonly provider_id: string;
  readonly disclosure_version: string;
  readonly created_at: Date | string;
}

const DISCLOSURES: Readonly<Record<string, SubscriptionDataDisclosure>> = {
  "openai-codex": {
    providerId: "openai-codex",
    version: "openai-codex-data-controls-2026-07-13",
    title: "개인용 Codex 데이터 처리 고지",
    summary:
      "개인용 ChatGPT/Codex에서는 콘텐츠가 모델 개선에 사용될 수 있습니다. ChatGPT 데이터 제어와 Codex 전체 실행 환경 제어는 별도이므로, 로그인 전에 두 설정을 직접 확인해야 합니다.",
    documentationUrl: "https://help.openai.com/en/articles/5722486-how-your-data-is-used-to-improve-model-performance",
  },
};

function text(value: string, label: string, maximum = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}이 유효하지 않습니다`);
  }
  return normalized;
}

function acknowledged(record: DisclosureRecord): SubscriptionDataDisclosureAcknowledgement {
  const timestamp =
    record.created_at instanceof Date ? record.created_at.toISOString() : new Date(record.created_at).toISOString();
  if (!Number.isFinite(new Date(timestamp).getTime()))
    throw new Error("데이터 처리 고지 동의 시각이 유효하지 않습니다");
  return {
    providerId: record.provider_id,
    version: record.disclosure_version,
    acknowledgedAt: timestamp,
  };
}

export function subscriptionDataDisclosure(providerId: string): SubscriptionDataDisclosure {
  const disclosure = DISCLOSURES[text(providerId, "제공자 ID")];
  if (!disclosure) throw new Error("이 제공자에는 확인 가능한 데이터 처리 고지가 없습니다");
  return disclosure;
}

export class SubscriptionDataDisclosureService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<SubscriptionDataDisclosureService> {
    await applyMigrations(database, [SUBSCRIPTION_DATA_DISCLOSURE_MIGRATION]);
    return new SubscriptionDataDisclosureService(database, organizations);
  }

  public async acknowledge(
    context: TenantContext,
    input: { readonly commandId: string; readonly providerId: string; readonly version: string },
  ): Promise<SubscriptionDataDisclosureAcknowledgement> {
    const disclosure = subscriptionDataDisclosure(input.providerId);
    if (text(input.version, "데이터 처리 고지 버전") !== disclosure.version) {
      throw new Error("데이터 처리 고지 버전이 현재 제공자 고지와 일치하지 않습니다");
    }
    const commandId = text(input.commandId, "명령 ID");
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const existing = await this.find(tx, context, disclosure);
      if (existing) return acknowledged(existing);
      await tx.query(
        `CREATE subscription_data_disclosure_acknowledgement CONTENT {
          acknowledgement_id: $acknowledgement_id,
          organization_id: $organization_id,
          user_id: $user_id,
          provider_id: $provider_id,
          disclosure_version: $disclosure_version,
          command_id: $command_id,
          created_at: time::now()
        };`,
        {
          acknowledgement_id: randomUUID(),
          organization_id: context.organizationId,
          user_id: context.userId,
          provider_id: disclosure.providerId,
          disclosure_version: disclosure.version,
          command_id: commandId,
        },
      );
      const created = await this.find(tx, context, disclosure);
      if (!created) throw new Error("데이터 처리 고지 동의 기록을 저장하지 못했습니다");
      return acknowledged(created);
    });
  }

  public async requireAcknowledgement(context: TenantContext, providerId: string): Promise<void> {
    const disclosure = subscriptionDataDisclosure(providerId);
    await this.organizations.verifyTenantContext(context);
    if (!(await this.find(this.database, context, disclosure))) {
      throw new Error("로그인을 시작하기 전에 현재 제공자의 데이터 처리 고지 동의가 필요합니다");
    }
  }

  private async find(
    executor: QueryExecutor,
    context: TenantContext,
    disclosure: SubscriptionDataDisclosure,
  ): Promise<DisclosureRecord | undefined> {
    const [records] = await executor.query<[DisclosureRecord[]]>(
      `SELECT provider_id, disclosure_version, created_at
       FROM subscription_data_disclosure_acknowledgement
       WHERE organization_id = $organization_id AND user_id = $user_id
         AND provider_id = $provider_id AND disclosure_version = $disclosure_version
       LIMIT 1;`,
      {
        organization_id: context.organizationId,
        user_id: context.userId,
        provider_id: disclosure.providerId,
        disclosure_version: disclosure.version,
      },
    );
    return records[0];
  }
}
