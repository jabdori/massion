import { createDefaultPolicy, type PolicyStore } from "@massion/governance";
import type { GrowthGateway } from "@massion/growth";
import type { IdentityService, OrganizationService } from "@massion/identity";
import type { OrganizationGraphService } from "@massion/organization";

import type { ApplicationAccessTokenService } from "./auth.js";
import type { TenantContext } from "@massion/identity";

export interface InitializeLocalApplicationInput {
  readonly commandId: string;
  readonly remoteAddress: string;
}

// 로컬 설치의 조직 루트입니다. 사람의 계정·Cloud profile은 이 경로로 만들지 않습니다.
const LOCAL_INSTALLATION_EMAIL = "local@massion.invalid";
const LOCAL_INSTALLATION_DISPLAY_NAME = "Massion Local";

function assertLoopback(input: InitializeLocalApplicationInput): void {
  if (!new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).has(input.remoteAddress)) {
    throw new Error("Application bootstrap은 loopback에서만 실행할 수 있습니다");
  }
}

export class LocalApplicationBootstrap {
  public constructor(
    private readonly identities: IdentityService,
    private readonly organizations: OrganizationService,
    private readonly graph: OrganizationGraphService,
    private readonly policies: PolicyStore,
    private readonly tokens: ApplicationAccessTokenService,
    // onboarding 시 Growth(메모리·프롬프트 정본) 시드를 활성화하기 위한 선택 의존성입니다.
    private readonly growth?: Pick<GrowthGateway, "start">,
    // 조직 컨텍스트가 준비된 뒤 시작해야 하는 제품 worker 연결점입니다.
    private readonly onInitialized?: (context: TenantContext) => void | Promise<void>,
  ) {}

  public async initialize(input: InitializeLocalApplicationInput) {
    assertLoopback(input);
    const registration = await this.identities.registerPersonalUser({
      email: LOCAL_INSTALLATION_EMAIL,
      displayName: LOCAL_INSTALLATION_DISPLAY_NAME,
    });
    const context = await this.organizations.resolveTenantContext(
      registration.user.user_id,
      registration.organization.organization_id,
    );
    const coreOffice = await this.graph.bootstrap(context);
    // 조직 graph가 만들어진 직후 Growth를 시작해 활성 PromptDefinitionVersion을 시드합니다.
    // 멱등이므로 onboarding 재시작에도 안전합니다.
    if (this.growth) await this.growth.start(context);
    await this.onInitialized?.(context);
    let policy = await this.policies.getActive(context);
    if (!policy) {
      const defaults = createDefaultPolicy("personal");
      const draft = await this.policies.createDraft(context, {
        commandId: `${input.commandId}:policy:draft`,
        bundle: defaults.bundle,
        requirements: defaults.requirements,
      });
      policy = await this.policies.activate(context, {
        commandId: `${input.commandId}:policy:activate`,
        policyVersionId: draft.policy_version_id,
      });
    }
    const access = await this.tokens.issue(context, {
      commandId: `${input.commandId}:token`,
      audience: "massion-api",
      scopes: ["application:*"],
      ttlSeconds: 3_600,
    });
    return { registration, context, coreOffice, policy, access };
  }
}
