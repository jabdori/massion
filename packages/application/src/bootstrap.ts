import { createDefaultPolicy, type PolicyStore } from "@massion/governance";
import type { IdentityService, OrganizationService } from "@massion/identity";
import type { OrganizationGraphService } from "@massion/organization";

import type { ApplicationAccessTokenService } from "./auth.js";

export interface InitializeLocalApplicationInput {
  readonly commandId: string;
  readonly remoteAddress: string;
  readonly trustedLocal: boolean;
  readonly email: string;
  readonly displayName: string;
}

function assertTrustedLoopback(input: InitializeLocalApplicationInput): void {
  if (!input.trustedLocal) throw new Error("Application bootstrap에는 trusted local capability가 필요합니다");
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
  ) {}

  public async initialize(input: InitializeLocalApplicationInput) {
    assertTrustedLoopback(input);
    const registration = await this.identities.registerPersonalUser({
      email: input.email,
      displayName: input.displayName,
    });
    const context = await this.organizations.resolveTenantContext(
      registration.user.user_id,
      registration.organization.organization_id,
    );
    const coreOffice = await this.graph.bootstrap(context);
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
