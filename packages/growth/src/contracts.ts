import type { TenantContext } from "@massion/identity";
import type { QueryExecutor } from "@massion/storage";

export type GrowthAdoptionMode = "review" | "auto";
export type GrowthConfigurationSubject =
  { readonly type: "organization" } | { readonly type: "user"; readonly userId: string };

export interface ConfigureGrowthInput {
  readonly commandId: string;
  readonly subject: GrowthConfigurationSubject;
  readonly reflectionEnabled: boolean;
  readonly adoptionMode: GrowthAdoptionMode;
  readonly expectedVersion?: number;
}

export interface GrowthConfigurationVersion {
  readonly configurationVersionId: string;
  readonly organizationId: string;
  readonly subject: GrowthConfigurationSubject;
  readonly version: number;
  readonly previousVersionId?: string;
  readonly reflectionEnabled: boolean;
  readonly adoptionMode: GrowthAdoptionMode;
  readonly status: "active" | "superseded";
  readonly governanceDecisionId: string;
  readonly checksum: string;
  readonly commandId: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly activatedAt: string;
  readonly supersededAt?: string;
}

export interface GrowthConfigurationGateway {
  configure(context: TenantContext, input: ConfigureGrowthInput): Promise<GrowthConfigurationVersion>;
  resolve(context: TenantContext, requesterUserId?: string): Promise<GrowthConfigurationVersion>;
}

export interface GrowthConfigurationAuthorizer {
  authorizeConfiguration(
    context: TenantContext,
    input: ConfigureGrowthInput,
    executor?: QueryExecutor,
  ): Promise<{ readonly governanceDecisionId: string }>;
}

const CALLER_PROJECTION_FIELDS = new Set([
  "activatedAt",
  "checksum",
  "configurationVersionId",
  "createdAt",
  "createdByUserId",
  "governanceDecisionId",
  "organizationId",
  "previousVersionId",
  "status",
  "supersededAt",
  "version",
]);

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`${label}는 1~200자여야 합니다`);
  }
}

export function validateGrowthConfigurationInput(input: unknown): ConfigureGrowthInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Growth 설정 입력은 object여야 합니다");
  }
  const record = input as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (CALLER_PROJECTION_FIELDS.has(field)) throw new Error(`caller는 ${field} projection을 주입할 수 없습니다`);
  }
  assertIdentifier(record.commandId, "명령 식별자");
  if (typeof record.reflectionEnabled !== "boolean") {
    throw new Error("Reflection 설정은 boolean이어야 합니다");
  }
  if (record.adoptionMode !== "review" && record.adoptionMode !== "auto") {
    throw new Error("개선안 반영 방식은 review 또는 auto여야 합니다");
  }
  if (!record.subject || typeof record.subject !== "object" || Array.isArray(record.subject)) {
    throw new Error("설정 대상이 필요합니다");
  }
  const subject = record.subject as Record<string, unknown>;
  if (subject.type === "user") assertIdentifier(subject.userId, "사용자 식별자");
  else if (subject.type !== "organization") throw new Error("설정 대상은 organization 또는 user여야 합니다");
  if (
    record.expectedVersion !== undefined &&
    (!Number.isSafeInteger(record.expectedVersion) || (record.expectedVersion as number) < 1)
  ) {
    throw new Error("expectedVersion은 1 이상인 안전한 정수여야 합니다");
  }
  return input as ConfigureGrowthInput;
}
